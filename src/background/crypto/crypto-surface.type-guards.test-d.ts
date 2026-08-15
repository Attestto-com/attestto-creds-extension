/**
 * Story 1.6 — the crypto-surface enumeration guard (compile channel, FR19/FR20).
 *
 * The rule that forbids a second or ungated sign is realized TYPE-level:
 * enumerate the crypto surface a ctx bundle exposes and assert it is EXACTLY
 * {sign, deriveForOrigin}. Any addition (`signRaw`, `signUnverified`, an
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
import type { Crypto } from '@/background/ports/ports'
import type { SigningCtx, KeyAdminCtx } from '@/background/ctx/ctx-bundles'

type Assert<T extends true> = T

/** The one allowed crypto surface. Widening this set must be a conscious edit. */
type AllowedCryptoKeys = 'sign' | 'deriveForOrigin'

// ── Signing is the only tier with a crypto surface, and it is exactly the two ──
type _SigningSurfaceExact = Assert<
  [Exclude<keyof SigningCtx['crypto'], AllowedCryptoKeys>] extends [never] ? true : false
>

// …and the allowed keys are actually PRESENT (guards against the surface
// shrinking to `never`, which would make the Exclude vacuously pass).
type _SigningHasBoth = Assert<AllowedCryptoKeys extends keyof SigningCtx['crypto'] ? true : false>

// ── AD-11c, pinned as ABSENCE: the key-admin tier cannot name a signer ────────
// Re-adding `crypto` to KeyAdminCtx reddens here, which is the conscious edit
// this guard exists to force.
type _KeyAdminHasNoCrypto = Assert<'crypto' extends keyof KeyAdminCtx ? false : true>

// ── AD-15: derivation cannot be keyed on an un-normalized origin ──────────────
// @ts-expect-error — a plain string is not assignable to CanonicalOrigin.
const _rawOriginRejected: Parameters<Crypto['deriveForOrigin']>[0] = 'https://x.example'
void _rawOriginRejected

export type { _SigningSurfaceExact, _SigningHasBoth, _KeyAdminHasNoCrypto }
