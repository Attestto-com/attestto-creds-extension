import { describe, it, expect, vi } from 'vitest'
import { createCounterpartyDidResolver, SUPPORTED_METHODS, DidResolutionError } from './did-resolver'
import { runPeerCheck, ALLOWED_PEER_METHODS } from './peer-verification'
import { MESSAGE_ROUTES } from '@/background/router/routes'

/**
 * Story 2.3 — BLOCKED, and this file is why.
 *
 * 2.3 was "make the DID_SYNC vm-binding check live". It is implemented
 * (`peer-verification.ts`), wired into the router (`dispatch.ts` stage 6), and
 * proven by tests. It is NOT switched on in `background.ts`, because switching
 * it on today would reject every real platform sync.
 *
 * ── The incompatibility ────────────────────────────────────────────────────
 *
 * `DID_SYNC` carries `did:sns:` identifiers — that is the Tier 2 (tenant) and
 * Tier 3 (user-root) flow described in this repo's CLAUDE.md, and it is the
 * strategic product direction. The resolver built in Story 2.1 supports `jwk`
 * and `web`. There is no SNS resolution anywhere in this codebase.
 *
 * So `vmBinding` on a `did:sns` holder resolves to `method-not-allowed`, the
 * check returns false, and dispatch answers `peer-verification-failed`. Every
 * Tier 2/3 identity sync would break.
 *
 * ── Why this is a spec and not a TODO comment ──────────────────────────────
 *
 * A comment saying "don't turn this on yet" is exactly the artefact this
 * codebase has repeatedly shipped and then contradicted. These tests FAIL the
 * moment the incompatibility is resolved — when `sns` joins the supported
 * methods — so the blocker cannot silently outlive its cause, and they fail if
 * someone widens the allowlist without building a resolver.
 *
 * ── The three ways forward, for a human to choose ──────────────────────────
 *
 * 1. Build a `did:sns` resolver (Solana RPC + SNS lookup). Needs an RPC
 *    provider decision and a host permission. Note the recorded constraint that
 *    an SNS name is NOT a verification key — resolution must produce the key
 *    from the record, not from the name.
 * 2. Have the platform emit a `did:web` or `did:jwk` holder for sync, keeping
 *    `did:sns` as a naming layer above it.
 * 3. Accept unverified `verificationMethod` for `did:sns` explicitly, as a
 *    recorded decision with an expiry — not as a silent gap.
 *
 * Until one is chosen, the check stays wired-and-off, and that state is HONEST
 * rather than hidden: `background.ts` runs no peer check, and says so.
 */

const SNS_DID = 'did:sns:alice.attestto.sol'

describe('Story 2.3 is blocked on did:sns resolution', () => {
  it('the resolver does not support the sns method', () => {
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

  it('🩸 vmBinding therefore REJECTS the real DID_SYNC payload shape', async () => {
    // This is the exact payload the platform sends today, per
    // did-sync.handler.spec.ts and utils/did-sync.spec.ts.
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
    // If this ever returns true, the blocker is gone and this file should go
    // with it. If it returns false while the check is ALSO switched on in
    // background.ts, Tier 2/3 sync is broken in production.
    expect(accepted).toBe(false)
  })

  it('the route still DECLARES the check, so turning it on is a one-line change', () => {
    // The work is done and reviewable; only activation is deferred.
    expect(MESSAGE_ROUTES.DID_SYNC.verifyPeer).toEqual({ check: 'vmBinding' })
  })

  /**
   * The activation guard. `background.ts` must not run a peer check on DID_SYNC
   * while the above holds. Asserted against the entrypoint's SOURCE because
   * `background.ts` lives inside `defineBackground()` and cannot be booted from
   * a spec — the same technique Story 1.14 used for its call-site guard.
   */
  it('background.ts does not run a peer check on DID_SYNC yet', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(
      resolve(__dirname, '../../entrypoints/background.ts'),
      'utf8',
    )
    // If someone wires it in, THIS test fails and points them at the three
    // options in the header — rather than the breakage showing up as users
    // silently unable to sync an identity.
    expect(source).not.toMatch(/runPeerCheck/)
    expect(source).not.toMatch(/createCounterpartyDidResolver/)
  })
})
