/**
 * Story 1.6 — the crypto-surface enumeration guard (compile channel, FR19/FR20).
 *
 * `lint:check` is broken (no ESLint flat config), so the "lint" that forbids a
 * second/ungated sign is realized TYPE-level: enumerate the crypto surface both
 * ctx bundles expose and assert it is EXACTLY {sign}. Any
 * addition (`signRaw`, `signUnverified`, an `originBuckets` accessor, …) widens
 * `keyof` and reddens this file — forcing a reviewer to consciously widen the
 * allowlist.
 *
 * Redline's Fork-F rule (from Story 1.5) is honored in the Dev Record: this guard
 * is NOT trusted until a watched mutation (add `signRaw` to `Crypto`) is seen to
 * make `vue-tsc` error here. A guard that cannot redden is worse than none.
 *
 * BOTH surfaces are enumerated independently (Murat/Redline): a divergence on
 * either reddens its own assertion, regardless of the AD-11c identity check.
 */
import type { SigningCtx, KeyAdminCtx } from '@/background/ctx/ctx-bundles'

type Assert<T extends true> = T

/** The one allowed crypto surface. Widening this set must be a conscious edit. */
type AllowedCryptoKeys = 'sign'

// ── No ungated sign / no linkable accessor on either bundle's crypto ──────────
type _SigningSurfaceExact = Assert<
  [Exclude<keyof SigningCtx['crypto'], AllowedCryptoKeys>] extends [never] ? true : false
>
type _KeyAdminSurfaceExact = Assert<
  [Exclude<keyof KeyAdminCtx['crypto'], AllowedCryptoKeys>] extends [never] ? true : false
>
// …and the allowed keys are actually PRESENT (guards against the surface shrinking
// to `never`, which would make the Exclude vacuously pass). This half matters more
// now that the surface is a single member: without it, deleting `sign` too would
// leave both assertions vacuously true.
type _SigningHasAll = Assert<AllowedCryptoKeys extends keyof SigningCtx['crypto'] ? true : false>
type _KeyAdminHasAll = Assert<AllowedCryptoKeys extends keyof KeyAdminCtx['crypto'] ? true : false>

// ── AD-11c: the two crypto surfaces are the SAME type (one primitive) ─────────
type _OneCryptoType = Assert<
  SigningCtx['crypto'] extends KeyAdminCtx['crypto']
    ? KeyAdminCtx['crypto'] extends SigningCtx['crypto']
      ? true
      : false
    : false
>

// ── AD-11a: derivation removed, not deferred (SOC-243) ───────────────────────
// This block asserted that `deriveForOrigin` was keyed on a CanonicalOrigin and
// rejected a raw string. The method is gone: deriving every site identity from
// one root key would make that key a master key over every relying party, and
// the decided design mints an independent random key per site instead (see the
// `Crypto` port for the full reasoning, and SOC-243 for the recovery story that
// replaces it).
//
// The assertions above still carry the load they were written for: adding any
// second crypto member — `signRaw`, `deriveForOrigin`, an `originBuckets`
// accessor — widens `keyof` and reddens this file.

// Re-exported so `noUnusedLocals` counts them as used. Without this block every
// assertion above is an unused local and the file fails to compile — which is
// how the guard announces that someone has edited it into silence.
export type {
  _SigningSurfaceExact,
  _KeyAdminSurfaceExact,
  _SigningHasAll,
  _KeyAdminHasAll,
  _OneCryptoType,
}
