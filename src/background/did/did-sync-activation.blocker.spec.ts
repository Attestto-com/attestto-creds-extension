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
 * ── CORRECTION, 2026-08-10: the blocker is SOC-87, and it predates this file ─
 *
 * This header previously offered "build a did:sns resolver" as option 1, then
 * offered three options of my own invention. Both were wrong, and the second
 * more embarrassingly than the first: a resolver exists, is published
 * (`@attestto/did-sns-resolver`), is DEPLOYED at `resolver.attestto.com` — and
 * the defect below was filed as **SOC-87 on 2026-07-20**, three weeks before I
 * re-derived it. It is still To Do. Do not re-derive it a third time.
 *
 * SOC-87 — "Enforce SNS name ≠ verification key: anchor doc-hash, separate
 * roles, stop owner→key default" — records both the symptom and the cause:
 *
 *   Symptom: `snsMetadata.owner` is byte-identical to `verificationMethod[0]`
 *   (`#key-1`), referenced by `authentication` AND `assertionMethod`.
 *   Cause:   `documentHash` was unanchored, so the resolver DEFAULTS `#key-1`
 *            to the owner wallet (`sns-resolver.ts:370-377`).
 *
 * The architecture this violates is DECIDED, not open (Confluence, "did:sns
 * Anchor Authority — Operator ≠ Authority", 2026-07-20): the subdomain's SNS
 * record data space is the CONTAINER FOR THE DID DOCUMENT — the user's
 * verification keys are written there, separate from the domain-owner wallet.
 * Attestto operates the record; it is never the key authority. SOC-87's target
 * shape: owner wallet → `capabilityInvocation` only, vault Ed25519 →
 * `authentication`/`assertionMethod`, X25519 → `keyAgreement`.
 *
 * ⚠️ `did-sns-spec` §8.5 CONTRADICTS that decision — it still says `#solana-key`
 * MUST be the SNS owner's key. The spec predates the decision and was never
 * updated (SOC-87 anticipated this: "consider a follow-up spec note"). Reading
 * §8.5 as authoritative is what made me file the decided model as the defect.
 * The spec is the stale artefact here, not the rule.
 *
 * ── Where the three SOC-87 touchpoints stand (verified live, 2026-08-10) ────
 *
 *   1. Registrar writes a real `documentHash` — PARTIAL. SOC-87 saw all zeros;
 *      `did:sns:attestto` now carries `71c41848…`. But nothing serves the
 *      document that hash commits to, so the anchor changes nothing observable.
 *   2. Key-gen uses the vault key, not the owner wallet — UNVERIFIABLE from
 *      outside, and moot while (3) holds: the resolver never reads a document,
 *      so a correct key inside one would never surface.
 *   3. Resolver refuses the owner→key default and verifies the hash — NOT DONE.
 *      `documentHash` is parsed, copied into metadata, and never used. There is
 *      no document-fetch path in `server.ts` at all.
 *
 * Related: SOC-84 ("degraded fallback is a downgrade attack with no
 * machine-readable warning") is marked DONE — but only the spec changed. §9.1,
 * §9.2 and §12 now require `didResolutionMetadata.degraded = true`; the word
 * `degraded` appears ZERO times in the resolver, and the live service omits it.
 * So an unwritten SNS domain still returns a document indistinguishable from a
 * registered identity. That is how this file's author misread one.
 *
 * ── What that means for 2.3 ────────────────────────────────────────────────
 *
 * `DID_SYNC` sends `verificationMethod: did:sns:<name>#key-1` (see
 * `did-sync.handler.spec.ts`) — the same defaulted fragment the resolver
 * synthesises. So the two halves MATCH, and switching `vmBinding` on would not
 * fail: it would PASS and report a verified binding. Green, because both sides
 * derive from the same owner-wallet default. A control that exists, looks like
 * it covers the invariant, and agrees with the one thing it was supposed to be
 * independent of.
 *
 * The blocker is therefore NOT a technical gap in this repo, and not a choice
 * between options. It is the single open decision on SOC-87, owned by Eduardo:
 * does the owner wallet appear in-document as `capabilityInvocation`, or stay
 * entirely off-document? Everything downstream — resolver fix, registrar
 * anchor, and this check — waits on that. SOC-85 (co-authorization) and SOC-86
 * (continuity anchor) are To Do in the same family.
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
