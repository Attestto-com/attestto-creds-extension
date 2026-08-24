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
 * Prove a fresh, present human immediately before signing THIS payload.
 * Fail-closed: MUST reject when the user is absent/cancels. The bound
 * implementation is `requireUserVerification` (WebAuthn assertion,
 * `userVerification: 'required'`), bound at the composition root (Story 1.13).
 *
 * PAYLOAD-BOUND (Story 1.11, WYSIWYS): the gate receives the exact bytes about to
 * be signed, so a presence proof authorizes ONE operation — a proof minted for
 * request A cannot gate request B. The passthrough binding used until 1.13 ignores
 * the argument; the deferred cross-process UV-proof (see planning-artifacts) is
 * where the payload actually gets checked. Widening `assertPresence` back to
 * `() => Promise<void>` would silently re-open cross-request proof replay.
 */
export type PresenceGate = (payload: Uint8Array) => Promise<void>

/**
 * The raw signer over already-unlocked key material. A composition-root-only
 * value — never exported into a handler bundle, so it cannot be called ungated.
 */
export type RawSign = (payload: Uint8Array) => Promise<Signature>

/**
 * SOC-279 — the gate the service worker binds TODAY, and it verifies nothing.
 *
 * This exists so the deferral has a name. `createSigningAdapters` used to default
 * a missing `assertPresence` to an anonymous `async () => {}`, so the shipped
 * build silently took a no-op gate and the composition root looked complete.
 * Passing this explicitly makes "there is no liveness check in the background"
 * a statement someone wrote down, not a default nobody read.
 *
 * Why it cannot simply be replaced with the real gate: `navigator.credentials`
 * does not exist in an MV3 service worker, so `requireUserVerification` CANNOT
 * run here — importing it into `background.ts` would throw at runtime and break
 * every signing path. Liveness currently lives in the approval window
 * (`approval/App.vue`), which does a real WebAuthn UV before dispatching any
 * `*_APPROVE`.
 *
 * The gap that leaves: a caller that sends `*_APPROVE` straight to the worker,
 * bypassing the window, gets a signature with no user present. Closing it needs
 * the cross-process UV-proof protocol — the popup mints a short-lived,
 * single-use proof bound to the payload hash and the worker verifies and
 * consumes it. That is designed but deliberately deferred; see
 * `_bmad-output/planning-artifacts/deferred/uv-proof-cross-process-liveness.md`
 * and SOC-279. `signing-presence-gate.blocker.spec.ts` pins this state so the
 * swap cannot happen by accident.
 */
export const DEFERRED_PRESENCE_PASSTHROUGH: PresenceGate = async () => {}

/**
 * Build the single gated signing primitive. Both deps are required. The returned
 * `sign` asserts presence, then signs — never the reverse, never without.
 */
export function createGatedSign(deps: {
  assertPresence: PresenceGate
  rawSign: RawSign
}): Crypto['sign'] {
  return async (payload: Uint8Array): Promise<Signature> => {
    await deps.assertPresence(payload) // fail-closed: a throw here means no signature; bound to THESE bytes
    return deps.rawSign(payload)
  }
}
