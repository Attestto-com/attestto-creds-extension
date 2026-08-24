/**
 * Story 1.6 — the crypto-surface enumeration guard (compile channel, FR19/FR20).
 *
 * The rule that forbids a second or ungated sign is realized TYPE-level:
 * enumerate the crypto surface a ctx bundle exposes and assert it is EXACTLY
 * {sign}. Any addition (`signRaw`, `signUnverified`, a `deriveForOrigin`, an
 * `originBuckets` accessor, …) widens `keyof` and reddens this file, forcing a
 * reviewer to consciously widen the allowlist.
 *
 * Not trusted until a watched mutation (add `signRaw` to `Crypto`) is seen to
 * make `vue-tsc` error here. A guard that cannot redden is worse than none.
 *
 * ── Changed in SOC-280 ────────────────────────────────────────────────────
 *
 * This file used to enumerate TWO surfaces — Signing's and KeyAdmin's — and
 * assert they were the same type, so no second signing path could appear.
 *
 * KeyAdmin no longer has a crypto surface at all. It declared one and nothing
 * ever used it: the only keyAdmin routes are DID_SYNC and KEY_ROTATE, and
 * neither signs — they read, write and generate. An unused signing capability on
 * the key-handling tier is one waiting to be picked up by mistake, and it was
 * blocking the bundle from being built at all (nothing could supply it
 * honestly).
 *
 * Removing it is a STRICTER reading of AD-11c, not a relaxation. "No bundle
 * exposes an alternative sign" is best satisfied by the tier being unable to
 * name one, so the identity assertion is replaced by an absence assertion.
 */
import type { SigningCtx, KeyAdminCtx } from '@/background/ctx/ctx-bundles'

type Assert<T extends true> = T

/** The one allowed crypto surface. Widening this set must be a conscious edit. */
type AllowedCryptoKeys = 'sign'

// ── Signing is the only tier with a crypto surface, and it is exactly the two ──
type _SigningSurfaceExact = Assert<
  [Exclude<keyof SigningCtx['crypto'], AllowedCryptoKeys>] extends [never] ? true : false
>

// …and the allowed key is actually PRESENT (guards against the surface shrinking
// to `never`, which would make the Exclude vacuously pass). This half matters
// more now that the surface is a single member: without it, deleting `sign` too
// would leave the assertion vacuously true.
type _SigningHasAll = Assert<AllowedCryptoKeys extends keyof SigningCtx['crypto'] ? true : false>

// ── AD-11c, pinned as ABSENCE: the key-admin tier cannot name a signer ────────
// Re-adding `crypto` to KeyAdminCtx reddens here, which is the conscious edit
// this guard exists to force.
type _KeyAdminHasNoCrypto = Assert<'crypto' extends keyof KeyAdminCtx ? false : true>

// ── AD-11a: derivation removed, not deferred (SOC-243) ───────────────────────
// This block asserted that `deriveForOrigin` was keyed on a CanonicalOrigin and
// rejected a raw string (AD-15). The method is gone: deriving every site identity
// from one root key would make that key a master key over every relying party,
// and the decided design mints an independent random key per site instead (see
// the `Crypto` port for the full reasoning, and SOC-243 for the recovery story
// that replaces it). An assertion about the shape of a deleted method cannot
// compile, and would be asserting nothing if it could.
//
// The assertions above still carry the load that one was written for: adding any
// second crypto member — `signRaw`, `deriveForOrigin`, an `originBuckets`
// accessor — widens `keyof` and reddens this file.

// Re-exported so `noUnusedLocals` counts them as used. Without this block every
// assertion above is an unused local and the file fails to compile — which is
// how the guard announces that someone has edited it into silence.
export type { _SigningSurfaceExact, _SigningHasAll, _KeyAdminHasNoCrypto }
