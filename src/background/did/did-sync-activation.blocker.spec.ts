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
 * ── CORRECTION, 2026-08-10: the blocker is NOT a missing resolver ───────────
 *
 * This header previously offered "build a did:sns resolver" as option 1. That
 * was wrong. One exists, is published (`@attestto/did-sns-resolver`), and is
 * DEPLOYED and public at `resolver.attestto.com` behind the DIF Universal
 * Resolver API. Wiring it in is a small job.
 *
 * Wiring it in is not the fix, though, because what it returns does not match
 * the did:sns method specification. Measured against the spec (§8.5 / §8.2,
 * `did-sns-spec/did-sns/spec/08-did-document.md`), the live service today
 * returns for EVERY record:
 *
 *     #key-1  Ed25519VerificationKey2020  publicKeyBase58: <SNS owner wallet>
 *     authentication: [#key-1]   assertionMethod: [#key-1]
 *
 * The owner wallet as a verification method is NOT wrong per se — §8.5 says
 * `#solana-key` MUST be the SNS owner's Solana public key. But that is a TIER 3
 * method, a self-custodial wallet for on-chain governance. §8.5 and the §8.2
 * note are explicit that Tier 1/2 expose ONLY `#firma-digital` and/or
 * `#attestto-sign`, with "no wallet keys, no keyAgreement".
 *
 * `sns-resolver.ts:370-377` emits it unconditionally, at every tier. Resolving
 * `did:sns:attestto` returns `isTier3: false` alongside the owner wallet in
 * `authentication`. The resolver PARSES the TIER_3 flag (0x04) into `isTier3`
 * and then never gates the key on it — so every Tier 1/2 identity publishes a
 * Solana address, which is precisely the transaction-history correlation §5.3
 * excludes wallet addresses from `alsoKnownAs` to prevent.
 *
 * Three conformance gaps ride along in the same function: the fragment `#key-1`
 * is not in §8.5's vocabulary; `publicKeyBase58` is emitted where the spec uses
 * `publicKeyMultibase` (§8.8's implementer note tells relying parties to read
 * `publicKeyMultibase`); and `#attestto-sign` / `#firma-digital` are never
 * emitted at all, so a conformant Tier 1/2 identity resolves with NO usable
 * verification method.
 *
 * And `DID_SYNC` sends `verificationMethod: did:sns:<name>#key-1` (see
 * `did-sync.handler.spec.ts`) — also not a spec fragment. So the two halves
 * MATCH, and switching `vmBinding` on would not fail: it would PASS and report
 * a verified binding. Green, because both sides are non-conformant in the same
 * direction. A control that exists, looks like it covers the invariant, and
 * agrees with the one thing it was supposed to be independent of.
 *
 * ── The options, restated against the spec ─────────────────────────────────
 *
 *   A. Make the resolver emit what §8.5 specifies, gated on the tier flag it
 *      already reads: `#attestto-sign` (and `#firma-digital` where it exists)
 *      for Tier 1/2, `#solana-key` in `publicKeyMultibase` for Tier 3 only.
 *      Then bind here to that fragment. Work in `attestto-did-resolver` and in
 *      whatever writes the on-chain record — not in this repo.
 *   B. Have the platform emit a `did:web` or `did:jwk` holder for sync, keeping
 *      `did:sns` as a naming layer above it. Cheapest; leaves the resolver's
 *      non-conformance in place for every other consumer.
 *   C. Accept unverified `verificationMethod` for `did:sns` explicitly, as a
 *      recorded decision with an expiry — not as a silent gap.
 *
 * What is NOT an option is turning the check on as-is. It would be green.
 *
 * ── Why this is a spec and not a TODO comment ──────────────────────────────
 *
 * A comment saying "don't turn this on yet" is exactly the artefact this
 * codebase has repeatedly shipped and then contradicted. These tests FAIL the
 * moment the incompatibility is resolved — when `sns` joins the supported
 * methods — so the blocker cannot silently outlive its cause, and they fail if
 * someone widens the allowlist without building a resolver.
 *
 * The options are A/B/C in the correction block above. Until one is chosen, the
 * check stays wired-and-off, and that state is HONEST rather than hidden:
 * `background.ts` runs no peer check, and says so.
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
