/**
 * Story 1.2 — Channel A: PERMANENT compile-time tripwires for the `Response<T>`
 * envelope contract (AD-14). No runtime code; Vitest never runs this file (not a
 * `*.spec.ts`). It is type-checked by `npm run type-check` (`vue-tsc -b --noEmit`).
 *
 * Each `@ts-expect-error` asserts a WRONG shape is rejected. If the guarantee ever
 * weakens so the wrong shape becomes legal, the suppressed error disappears, the
 * `@ts-expect-error` becomes an UNUSED SUPPRESSION, and `vue-tsc` fails on the
 * suppression itself — a self-guarding, checked-in tripwire (guardrail-i).
 *
 * The mutations these tripwires bite on (each WATCHED red then restored during the
 * build — see the story's Task 5):
 *   - delete the `Response` brand           → forged-literal ban (T1) reds
 *   - collapse `Response` to flat legacy     → narrowing tripwires (T2, T3) red
 *   - widen `ErrorCode` to `string`          → freeform-string tripwire (T5) reds
 *
 * NOTE on the single-writer ban (logic party Fork C, corrected during build):
 * under AD-14's real framing a handler returns DATA (its `T`), not the envelope —
 * so a handler returning a plain `{ ok, data }` literal is just a data object and
 * the brand cannot reject it (that would need structural-exclude, which Fork C
 * rejected). The brand's airtight, honest guarantee is narrower and correct: NO
 * code outside `response.ts` can mint a `Response`, because the brand symbol is
 * module-private. T1 below proves exactly that. The handler-returns-data contract
 * is a seam (see `RouterResponse` positive control); enforcing "a handler never
 * returns an envelope" is the composition-root guard's job in Story 1.13.
 */
import type { Response, ErrorCode } from './response'
import { ok, fail } from './response'
import type { RouterResponse } from './route'

// ── T1 (Fork C, single-writer via brand): only `ok`/`fail` can mint a `Response`.
// A plain literal — even the exact success shape — lacks the module-private brand,
// so it is NOT assignable to `Response`. Bites when the brand is deleted.
// @ts-expect-error — a plain literal cannot mint a branded Response; only ok()/fail() can
const _forged: Response<number> = { ok: true, data: 1 }
void _forged

// ── T2 (Fork B): `.data` is unreachable WITHOUT narrowing on `ok`. Bites when
// `Response<T>` is collapsed to the non-discriminated flat legacy shape.
declare const r: Response<string>
// @ts-expect-error — `.data` is not accessible before narrowing on the `ok` discriminant
const _noDataBeforeNarrow: string = r.data
void _noDataBeforeNarrow

// ── T3 (Fork B): `.error` is unreachable in the `ok: true` arm. Bites on the same
// flat-collapse mutation.
if (r.ok) {
  // @ts-expect-error — `.error` does not exist on the success arm
  const _noErrorOnOk: ErrorCode = r.error
  void _noErrorOnOk
}

// ── T4 (positive control): narrowed access compiles clean — both arms reachable
// after the discriminant check. Must stay green.
if (r.ok) {
  const _data: string = r.data
  void _data
} else {
  const _err: ErrorCode = r.error
  void _err
}

// ── T5 (Fork D): `ErrorCode` is a CLOSED set — a legacy freeform string is
// rejected. Bites when `ErrorCode` is widened to `string`.
// @ts-expect-error — a freeform legacy error string is not a member of the closed ErrorCode union
const _freeformRejected: ErrorCode = 'No DID configured'
void _freeformRejected

// ── T6 (positive control, Yui): the router's real usage — `ok(foo) | fail(code)`
// must unify to `Response<Foo>` (proves `fail`'s `Response<never>` is assignable to
// `Response<T>`). If this ever needs an `@ts-expect-error`, the envelope is unusable.
declare const cond: boolean
const _routerTernary: Response<number> = cond ? ok(42) : fail('handler-error')
void _routerTernary

// ── T7 (seam positive control): the router-emitted per-route type IS a `Response`.
// This is the route.ts seam Story 1.5 consumes. Importing `RouterResponse` is what
// reds this file before the route.ts tightening (Task 3) and greens it after.
declare const rr: RouterResponse<'DID_SYNC'>
const _seamIsResponse: Response<unknown> = rr
void _seamIsResponse
