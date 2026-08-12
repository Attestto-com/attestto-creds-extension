/**
 * Story 1.6 — the crypto-surface enumeration guard (compile channel, FR19/FR20).
 *
 * `lint:check` is broken (no ESLint flat config), so the "lint" that forbids a
 * second/ungated sign is realized TYPE-level: enumerate the crypto surface both
 * ctx bundles expose and assert it is EXACTLY {sign, deriveForOrigin}. Any
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
import type { Crypto } from '@/background/ports/ports'
import type { SigningCtx, KeyAdminCtx } from '@/background/ctx/ctx-bundles'
import type { CanonicalOrigin } from '@/utils/origin'

type Assert<T extends true> = T

/** The one allowed crypto surface. Widening this set must be a conscious edit. */
type AllowedCryptoKeys = 'sign' | 'deriveForOrigin'

// ── No ungated sign / no linkable accessor on either bundle's crypto ──────────
type _SigningSurfaceExact = Assert<
  [Exclude<keyof SigningCtx['crypto'], AllowedCryptoKeys>] extends [never] ? true : false
>
type _KeyAdminSurfaceExact = Assert<
  [Exclude<keyof KeyAdminCtx['crypto'], AllowedCryptoKeys>] extends [never] ? true : false
>
// …and the allowed keys are actually PRESENT (guards against the surface shrinking
// to `never`, which would make the Exclude vacuously pass).
type _SigningHasBoth = Assert<AllowedCryptoKeys extends keyof SigningCtx['crypto'] ? true : false>
type _KeyAdminHasBoth = Assert<AllowedCryptoKeys extends keyof KeyAdminCtx['crypto'] ? true : false>

// ── AD-11c: the two crypto surfaces are the SAME type (one primitive) ─────────
type _OneCryptoType = Assert<
  SigningCtx['crypto'] extends KeyAdminCtx['crypto']
    ? KeyAdminCtx['crypto'] extends SigningCtx['crypto']
      ? true
      : false
    : false
>

// ── AD-11a: derivation is keyed on a CANONICAL origin (unlinkable-by-shape) ────
// `deriveForOrigin` takes one CanonicalOrigin and returns one record; the absence
// of any `originBuckets`/`exportAllDerived` accessor is covered by the exact-surface
// assertions above (SHAPE only — runtime distinctness is the adapter's, Story 1.13).
type _DeriveParamIsCanonical = Assert<
  Parameters<Crypto['deriveForOrigin']>[0] extends CanonicalOrigin ? true : false
>
// A raw string is NOT accepted where a CanonicalOrigin is required (so derivation
// can't be keyed on an un-normalized origin — ties to AD-15).
// @ts-expect-error — a plain string is not assignable to CanonicalOrigin.
const _rawOriginRejected: Parameters<Crypto['deriveForOrigin']>[0] = 'https://x.example'
void _rawOriginRejected

export type {
  _SigningSurfaceExact,
  _KeyAdminSurfaceExact,
  _SigningHasBoth,
  _KeyAdminHasBoth,
  _OneCryptoType,
  _DeriveParamIsCanonical,
}
