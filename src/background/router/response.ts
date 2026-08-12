/**
 * Story 1.2 — the single `Response<T>` envelope (AD-14).
 *
 * ONE home for the wallet's inter-context response shape, replacing the 82 ad-hoc
 * `sendResponse({ ok … })` shapes in `background.ts` (data as siblings of `ok`,
 * freeform error strings, opaque pass-through). Three invariants live here:
 *
 *   1. Discriminated union keyed on `ok` — a dropped MV3 port reads as *failure*
 *      at the caller (FR16d), and no two handlers return incompatible shapes.
 *   2. Closed `ErrorCode` — errors are members of a fixed set, never freeform.
 *   3. SINGLE WRITER — `Response` carries a module-private brand only `ok`/`fail`
 *      can set, so a handler literally cannot fabricate the envelope. Handlers
 *      return `data` (their `T`); the router (Story 1.5) is the sole minter.
 *
 * Shim-first (AD-12): declared and exported, NOT consumed. The legacy switch and
 * its 82 `sendResponse` calls still own all runtime behavior. Story 1.5 wires the
 * router, which is where `ok`/`fail` are first called and where the drop-reads-as-
 * failure / consumed-replay wraps (FR16d) are implemented.
 *
 * Pure module (NFR-3, MV3/CSP): no `chrome.*`, no import-time side effects.
 */

/**
 * The router's response envelope. A two-arm discriminated union keyed on `ok`,
 * intersected with a module-private brand so ONLY `ok`/`fail` below can mint a
 * value of this type (AD-14 single-writer). Narrowing on `ok` distributes across
 * the intersection, so `.data` is reachable only on the success arm and `.error`
 * only on the failure arm.
 */
export type Response<T> = (
  | { ok: true; data: T }
  | { ok: false; error: ErrorCode }
) & { readonly [brand]: 'Response' }

/**
 * The unforgeable brand. `declare const … : unique symbol` is a compile-time-only
 * marker (no runtime emit); it is NOT exported, so no code outside this file can
 * name it — hence no code outside `ok`/`fail` can construct a `Response`.
 */
declare const brand: unique symbol

/**
 * The closed set of failure codes. Each maps to a router pipeline stage (AD-6) or
 * the FR16d idempotency seam. 1.2 CONSUMES NONE of these (only the type-fixtures
 * reference one); Story 1.5's chokepoint is the first writer.
 *
 * Label: this set proves *closed*, not *right-codes* — the exact membership is
 * Story 1.5's to ratify against the real pipeline.
 */
export type ErrorCode =
  | 'unknown-type' //             stage 2: no route for this message type       — consumed in Story 1.5
  | 'forbidden-origin' //         stage 3: origin not permitted by allowFrom     — consumed in Story 1.5
  | 'forbidden-sender' //         stage 3: sender not permitted by allowFrom     — consumed in Story 1.5
  | 'invalid-payload' //          stage 4: payload failed shape validation       — consumed in Story 1.5
  | 'peer-verification-failed' // stage 6: counterparty-DID check failed (AD-9)  — consumed in Epic 2
  | 'handler-error' //            stage 7: the handler threw                     — consumed in Story 1.5
  | 'port-dropped' //             stage 8: MV3 port dropped → reads as failure   — consumed in Story 1.5 (FR16d)
  | 'replayed' //                 stage 8: pending row already consumed          — consumed in Story 1.5 (FR16d)

/**
 * Mint a success envelope. One of exactly two functions permitted to produce a
 * `Response` (the `as` cast is confined here — nowhere else casts to `Response`).
 */
export const ok = <T>(data: T): Response<T> => ({ ok: true, data }) as Response<T>

/**
 * Mint a failure envelope. `Response<never>` is assignable to `Response<T>` for
 * any `T` (the failure arm names no `T`), so the router can write
 * `cond ? ok(data) : fail(code)` and get a `Response<T>`.
 */
export const fail = (error: ErrorCode): Response<never> =>
  ({ ok: false, error }) as Response<never>
