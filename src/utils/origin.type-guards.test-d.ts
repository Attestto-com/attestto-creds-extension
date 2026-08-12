/**
 * Story 1.3 — Channel A: compile-time tripwires for the `CanonicalOrigin` brand
 * (AD-15). No runtime code; Vitest never runs this file. Type-checked by
 * `npm run type-check` (`vue-tsc -b --noEmit`).
 *
 * The brand's honest guarantee (logic party 2026-08-08): only `normalizeOrigin`
 * can mint a `CanonicalOrigin`, so when the router edge and its ports type their
 * origin parameter as `CanonicalOrigin` (Story 1.5/1.4), a raw un-normalized
 * `sender.origin` cannot reach a consumer (compile error) — "normalized once, no
 * re-derivation" enforced by the type system.
 *
 * Label (honest): this proves the brand is UNFORGEABLE now; nothing REQUIRES it
 * yet (the ports are Story 1.5/1.4). Installing the brand on the output here is the
 * one cheap moment — before 1.5 re-touches every call-site.
 *
 * Mutation this bites on (watched red then restored): drop the brand from
 * `CanonicalOrigin` → a raw string assigns → the suppression goes unused → red.
 */
import { normalizeOrigin, type CanonicalOrigin } from '@/utils/origin'

// ── Tripwire: a raw `string` is NOT a `CanonicalOrigin` — only `normalizeOrigin`
// mints one. Bites when the brand is removed.
declare const raw: string
// @ts-expect-error — a raw string cannot be assigned to the branded CanonicalOrigin
const _rejectsRaw: CanonicalOrigin = raw
void _rejectsRaw

// ── Positive control 1: `normalizeOrigin`'s non-null result IS a `CanonicalOrigin`.
const normalized = normalizeOrigin('https://x.com')
if (normalized !== null) {
  const _isCanonical: CanonicalOrigin = normalized
  void _isCanonical
}

// ── Positive control 2: a `CanonicalOrigin` is still usable everywhere a `string`
// is (it is a subtype) — so existing map-key / comparison consumers do not break.
declare const canon: CanonicalOrigin
const _usableAsString: string = canon
void _usableAsString
const _usableAsKey: Record<string, number> = { [canon]: 1 }
void _usableAsKey
