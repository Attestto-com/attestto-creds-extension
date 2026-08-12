/**
 * Story 1.3 (AD-15) — the ONE canonical origin normalizer.
 *
 * The wallet keys pairwise-unlinkable identities, per-origin trust, the platform
 * allowlist, site-identity prefs, and the router-edge sender resolver all off the
 * *origin* of a request. If those consumers disagree on the canonical form by even
 * one byte, a `:443`/trailing-slash variant can pass one check yet land in a
 * different pairwise-DID bucket in another (AD-11a unlinkability split, or worse: a
 * site trusted under one string that authenticates as a DID derived from another).
 *
 * Discovery found this invariant unguarded by FIVE byte-identical copies of this
 * body under five names. This is now their single home (AD-8 one-home / NFR-4).
 *
 * What the canonical form does — and what it deliberately leaves to `new URL`:
 *   - strips path / query / fragment           (uses `.host`, not `.href`)
 *   - lowercases host + punycodes IDN           (the WHATWG URL parser does this)
 *   - drops the scheme-DEFAULT port `:443`/`:80` (the parser does this too —
 *     `new URL('https://x.com:443').host === 'x.com'`; there was NO default-port
 *     divergence to fix, contrary to a pre-build assumption)
 *   - KEEPS a non-default port (`http://localhost:4321` → `localhost:4321`)
 *
 * `.host` (never `.hostname`) is load-bearing: `.hostname` would drop *all* ports
 * including `:4321`, breaking local platform development. Do not change it.
 *
 * The return is a branded `CanonicalOrigin` (AD-15 seam): only this function can
 * mint one, so when the router edge (Story 1.5) and its ports type their origin
 * parameter as `CanonicalOrigin`, passing a raw `sender.origin` un-normalized is a
 * compile error — "normalized once, no re-derivation" enforced by the type system.
 */

declare const canonicalOriginBrand: unique symbol

/**
 * An origin reduced to its canonical `protocol//host` form. A `string` subtype
 * (so it works anywhere a string does — map keys, comparisons) that ONLY
 * `normalizeOrigin` can produce.
 */
export type CanonicalOrigin = string & { readonly [canonicalOriginBrand]: 'CanonicalOrigin' }

/** Reduce an origin/URL to its canonical form, or `null` for unusable input. */
export function normalizeOrigin(origin: string | null | undefined): CanonicalOrigin | null {
  if (!origin) return null
  try {
    const u = new URL(origin)
    return `${u.protocol}//${u.host}` as CanonicalOrigin
  } catch {
    return null
  }
}
