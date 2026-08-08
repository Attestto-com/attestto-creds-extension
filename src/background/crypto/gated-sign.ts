/**
 * Story 1.6 — the WebAuthn-gated signing primitive (AD-11c, FR19).
 *
 * The monolith enforced signing liveness by HABIT: `approval/App.vue` calls
 * `requireUserVerification()` before signing, but nothing structural stops a path
 * from signing without it (an unlocked vault caches its session key). This factory
 * makes the gate a property of the ONLY signing primitive that exists:
 *
 *   - `assertPresence` is a REQUIRED dep → the primitive is un-constructable
 *     without a gate ("non-optional" enforced at the call site).
 *   - The returned `sign` `await`s the gate and ONLY THEN delegates to `rawSign`.
 *     A gate rejection propagates; `rawSign` is never reached — fail-closed.
 *   - This is the only export that yields a `Crypto['sign']`; `rawSign` is never
 *     handed to a bundle. Combined with AD-2 (no port returns a raw key — 1.4),
 *     the only reachable signature path for a handler is this gated `sign`. That
 *     is "un-constructable-around": not "we remembered to gate," but "there is
 *     nothing else to call." The crypto-surface enumeration guard
 *     (`crypto-surface.type-guards.test-d.ts`) is the matching negative fence.
 *
 * Pure module (NFR-3, MV3/CSP): no `chrome.*`/`navigator.*`. The real, fail-closed
 * gate is `requireUserVerification` (`utils/webauthn.ts`), INJECTED as
 * `assertPresence` by the composition root (Story 1.13) — never imported here.
 * Shim-first (AD-12): declared, not consumed; `background.ts` still signs its way.
 */
import type { Crypto, Signature } from '@/background/ports/ports'

/**
 * Prove a fresh, present human immediately before signing. Fail-closed: MUST
 * reject when the user is absent/cancels. The bound implementation is
 * `requireUserVerification` (WebAuthn assertion, `userVerification: 'required'`).
 */
export type PresenceGate = () => Promise<void>

/**
 * The raw signer over already-unlocked key material. A composition-root-only
 * value — never exported into a handler bundle, so it cannot be called ungated.
 */
export type RawSign = (payload: Uint8Array) => Promise<Signature>

/**
 * Build the single gated signing primitive. Both deps are required. The returned
 * `sign` asserts presence, then signs — never the reverse, never without.
 */
export function createGatedSign(deps: {
  assertPresence: PresenceGate
  rawSign: RawSign
}): Crypto['sign'] {
  return async (payload: Uint8Array): Promise<Signature> => {
    await deps.assertPresence() // fail-closed: a throw here means no signature
    return deps.rawSign(payload)
  }
}
