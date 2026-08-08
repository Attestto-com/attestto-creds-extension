/**
 * Story 1.1 — the `Route<K>` skeleton (AD-5: route entries are data only).
 *
 * The five fields are fixed here; their TYPES are forward-declared placeholders
 * that later stories tighten IN PLACE (so `main` stays green each commit) rather
 * than restructure:
 *   - `bundle`     — trust-tier tag; the real capability-scoped `ctx` bundle types are Story 1.4.
 *   - `allowFrom`  — declarative `{ origins, senders }` descriptor (AD-7); matching logic is Story 1.5.
 *   - `validate`   — per-route pure-sync narrowing validator (zod-backed, must-narrow); real schemas are Story 1.5.
 *   - `handle`     — `(payload, ctx) => Promise<HandlerData<K>>`; returns DATA only (AD-14, Story 1.2). `ctx` is Story 1.4.
 *   - `verifyPeer` — router-owned counterparty check (AD-9); filled in Epic 2.
 *
 * Nothing here is consumed yet (AD-12 shim-first): the legacy switch still
 * dispatches. Route values are inert placeholders — never a real handler body
 * (a handler outside a handler module is exactly what Story 1.13's
 * composition-root guard forbids).
 */
import type { MessageType, MessagePayload } from './message-types'
import type { Response } from './response'

/** Trust tier a route runs under. Tightened to real `ctx` bundle types in Story 1.4. */
export type CtxBundleTag = 'untrusted' | 'signing' | 'consent' | 'keyAdmin'

/** Declarative sender policy. Empty = admits zero senders (fail-closed). Tightened in Story 1.5. */
export interface AllowFromDescriptor {
  origins: readonly string[]
  senders: readonly string[]
}

/** Placeholder ctx — the capability-scoped bundle types are Story 1.4. */
export type CtxPlaceholder = never

/**
 * Per-route handler OUTPUT data — the handler's `T` (AD-14: handlers return data,
 * the router owns the envelope). A placeholder until handlers are extracted with
 * their concrete data types (Stories 1.9+); it is deliberately per-route (keyed on
 * `K`) so tightening one route later does not disturb the others. This is internal
 * handler output, not untrusted input, so an `unknown` placeholder here is not the
 * disguised-`unknown` payload hazard Story 1.1's AC5 guards against.
 */
// Placeholder keyed on `K`: resolves to `unknown` for every route today; the
// `K extends …` seam becomes a real per-route data mapping as handlers extract (1.9+).
export type HandlerData<K extends MessageType> = K extends MessageType ? unknown : never

/**
 * What the router EMITS for a route: the handler's data wrapped in the single
 * `Response<T>` envelope (AD-14). The router is the sole writer of this — handlers
 * never construct it. Story 1.5's chokepoint produces it via `ok`/`fail`.
 */
export type RouterResponse<K extends MessageType> = Response<HandlerData<K>>

/** Pure-sync narrowing validator. Real zod schemas + must-narrow are Story 1.5. */
export type RouteValidator<K extends MessageType> = (raw: unknown) => MessagePayload<K>

/**
 * Handler over the validated payload + injected ctx. Returns DATA only
 * (`HandlerData<K>`, AD-14) — never the `Response` envelope, which the router owns.
 * `ctx` stays `never` until Story 1.4 builds the capability-scoped bundles.
 */
export type RouteHandler<K extends MessageType> = (
  payload: MessagePayload<K>,
  ctx: CtxPlaceholder,
) => Promise<HandlerData<K>>

/** A single registry entry — data only (AD-5). */
export interface Route<K extends MessageType> {
  bundle: CtxBundleTag
  allowFrom: AllowFromDescriptor
  validate: RouteValidator<K>
  handle: RouteHandler<K>
  verifyPeer?: unknown // router-owned counterparty check (AD-9); filled in Epic 2
}
