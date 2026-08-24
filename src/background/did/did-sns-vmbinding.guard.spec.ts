import { describe, it, expect, vi } from 'vitest'
import { createCounterpartyDidResolver, SUPPORTED_METHODS, DidResolutionError } from './did-resolver'
import { runPeerCheck, ALLOWED_PEER_METHODS } from './peer-verification'
import { MESSAGE_ROUTES } from '@/background/router/routes'

/**
 * SOC-280 — was `did-sync-activation.blocker.spec.ts`, the file that kept the
 * `vmBinding` check switched off. It no longer blocks; it guards the one way the
 * check can go quietly wrong.
 *
 * ── Why the block is lifted (Eduardo, 2026-08-14) ──────────────────────────
 *
 * The block rested on `DID_SYNC` carrying `did:sns:` identifiers, so activating
 * `vmBinding` would break every Tier 2/3 sync. Two corrections to that premise:
 *
 *   1. **did:sns is deferred, and it is the LAST thing built** — after ID
 *      verification. It is not the flow the extension needs to work today.
 *   2. **did:sns is scoped to bank transfers, not login.** Login is pairwise
 *      per-site `did:jwk` (`findOrCreateSiteDid`) — no alias, no username, no
 *      password. So the `vmBinding` check does not sit on the login path at all.
 *
 * The product shape behind that, because it explains why no login flow will ever
 * carry an SNS name: the user never sees a username, a password, a DID, or a
 * wallet address. The extension holds all of it internally. An SNS alias is
 * granted only AFTER the full verification and onboarding flow, it is presented
 * with the `.sol` and the wallet address hidden, and the user is not told it is
 * an SNS domain at all. That end of the flow is not implemented and belongs to the
 * Circle epic — which is consistent with SNS being a transfers identifier.
 *
 * With `sns` unsupported by the resolver, a `did:sns` holder now fails CLOSED
 * rather than being waved through, which is the correct posture for a method
 * this build cannot verify. `vmBinding` is live in `background.ts` as of
 * SOC-280: a page can no longer name a verification method that the claimed
 * DID's document does not authorise.
 *
 * ── What this file still guards, and it is subtle ──────────────────────────
 *
 * The original analysis found something worth keeping. `DID_SYNC` sends
 * `verificationMethod: did:sns:<name>#key-1`, and the SNS resolver SYNTHESISES
 * that same `#key-1` by defaulting it to the owner wallet (`sns-resolver.ts`,
 * because `documentHash` is unanchored). So the day `sns` becomes resolvable,
 * `vmBinding` would compare two values that derive from the same default and
 * report a verified binding — green, while checking nothing.
 *
 * That is SOC-87 ("Enforce SNS name ≠ verification key"), filed 2026-07-20 and
 * still To Do. Its open decision is Eduardo's: does the owner wallet appear
 * in-document as `capabilityInvocation`, or stay entirely off-document? The
 * resolver fix, the registrar anchor, and the meaning of this check all wait on
 * it. Related: SOC-85 (co-authorization), SOC-86 (continuity anchor), SOC-84
 * (the `degraded` flag the spec requires and the resolver never emits).
 *
 * So the guard below is on the ALLOWLIST, not on activation: adding `sns` to the
 * supported methods reddens this file, and whoever does it has to read SOC-87
 * first. That is the failure mode worth catching — a control that turns green
 * by agreeing with the one thing it was supposed to be independent of.
 */

const SNS_DID = 'did:sns:alice.attestto.sol'

describe('did:sns cannot join the peer-check allowlist before SOC-87', () => {
  it('the resolver does not support the sns method', () => {
    // Adding `sns` here without resolving SOC-87 makes `vmBinding` vacuous for
    // every SNS identity. Read SOC-87 before touching this.
    expect([...SUPPORTED_METHODS]).not.toContain('sns')
    expect([...ALLOWED_PEER_METHODS]).not.toContain('sns')
  })

  it('resolving a did:sns holder fails with method-not-allowed', async () => {
    const resolver = createCounterpartyDidResolver({
      http: { getJson: vi.fn() },
      clock: { now: () => 0 },
    })
    let reason = 'did-not-throw'
    try {
      await resolver.resolve(SNS_DID, { allowMethods: ALLOWED_PEER_METHODS })
    } catch (err) {
      reason = (err as DidResolutionError).reason
    }
    expect(reason).toBe('method-not-allowed')
  })

  it('vmBinding therefore REJECTS a did:sns payload — fail-closed, not waved through', async () => {
    // The posture this codebase should have for a method it cannot verify. It
    // is also why activating the check was safe: SNS is deferred, and a
    // deferred method that fails closed breaks nothing that runs today.
    const resolver = createCounterpartyDidResolver({
      http: { getJson: vi.fn() },
      clock: { now: () => 0 },
    })
    const accepted = await runPeerCheck(
      { check: 'vmBinding' },
      {
        payload: {
          requestId: 'req-1',
          holderDid: SNS_DID,
          verificationMethod: `${SNS_DID}#ext-key`,
        },
        resolver,
      },
    )
    expect(accepted).toBe(false)
  })

  it('the route declares the check, and the entrypoint now RUNS it', async () => {
    expect(MESSAGE_ROUTES.DID_SYNC.verifyPeer).toEqual({ check: 'vmBinding' })

    // The inverse of the assertion this file used to carry. It demanded that
    // `background.ts` run no peer check; it now demands the opposite, because
    // the entrypoint dispatches through the router and the router owns stage 6.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(resolve(__dirname, '../../entrypoints/background.ts'), 'utf8')
    expect(source).toContain('createCounterpartyDidResolver')
    expect(source).toContain('peerResolver')
  })
})
