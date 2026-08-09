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
import type {
  UntrustedCtx,
  SigningCtx,
  ConsentCtx,
  KeyAdminCtx,
} from '@/background/ctx/ctx-bundles'
import type { VerifyPeerDescriptor } from '@/background/did/peer-verification'

/** Trust tier a route runs under. Load-bearing since Story 1.4 (see `CtxByTag`). */
export type CtxBundleTag = 'untrusted' | 'signing' | 'consent' | 'keyAdmin'

/** Declarative sender policy. Empty = admits zero senders (fail-closed). Matched in Story 1.5. */
export interface AllowFromDescriptor {
  origins: readonly string[]
  senders: readonly string[]
}

/**
 * The ONE tag → ctx-bundle map (Story 1.5, AD-3/AD-6). Both the compile-time
 * `CtxFor<Tag>` below and the runtime bundle factory injected into `dispatch`
 * (`buildBundle: <T>(tag: T) => CtxFor<T>`) reference this single artifact, so a
 * factory that returns the wrong bundle for a tag fails to type-check — the map
 * and the type cannot silently drift (the AD-6 "green ≠ correct" trap). A missing
 * tag here makes `CtxFor` error for that tag (see the coverage assertion below).
 */
export interface CtxByTag {
  untrusted: UntrustedCtx
  signing: SigningCtx
  consent: ConsentCtx
  keyAdmin: KeyAdminCtx
}

/** The capability-scoped ctx a route of a given trust tier receives (AD-3). */
export type CtxFor<Tag extends CtxBundleTag> = CtxByTag[Tag]

/**
 * The union of every ctx bundle — what the router's `buildBundle(route.bundle)`
 * yields when the tag is only known as the widened `CtxBundleTag` (i.e. inside
 * `dispatch`, iterating the heterogeneous registry). A handler cannot name ANY
 * capability off this union without narrowing, which is exactly why a *route*
 * fixes its tag (`Route<K, Tag>`) so its handler receives the precise `CtxFor<Tag>`.
 */
export type AnyCtx = CtxByTag[CtxBundleTag]

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
 * Handler over the validated payload + the capability-scoped ctx for the route's
 * trust tier. Returns DATA only (`HandlerData<K>`, AD-14) — never the `Response`
 * envelope, which the router owns. `ctx` is `CtxFor<Tag>`: a `signing` route's
 * handler receives `SigningCtx` and cannot even *name* a `KeyAdminCtx`-only
 * capability (a compile error) — capability confinement by shape (AD-3).
 *
 * Declared as a METHOD signature on `Route` (not an arrow property) on purpose:
 * the registry stores routes heterogeneously as `Route<K, CtxBundleTag>`, and
 * method-parameter bivariance is what lets a precisely-tagged `Route<K, 'signing'>`
 * be stored there without widening its handler's `ctx` to the unusable `AnyCtx`.
 * Confinement still bites at the *construction* site, where the tag is precise.
 */
export type RouteHandler<K extends MessageType, Tag extends CtxBundleTag = CtxBundleTag> = (
  payload: MessagePayload<K>,
  ctx: CtxFor<Tag>,
) => Promise<HandlerData<K>>

/** A single registry entry — data only (AD-5). `Tag` fixes the route's trust tier. */
export interface Route<K extends MessageType, Tag extends CtxBundleTag = CtxBundleTag> {
  bundle: Tag
  allowFrom: AllowFromDescriptor
  validate: RouteValidator<K>
  // Method signature (bivariant ctx) so `Route<K,'signing'>` stores as `Route<K>`.
  handle(payload: MessagePayload<K>, ctx: CtxFor<Tag>): Promise<HandlerData<K>>
  /**
   * Router-owned counterparty check (AD-9), Story 2.2.
   *
   * Was `unknown` through Epic 1, which let both real routes declare an OBJECT
   * descriptor while `dispatch` executed only FUNCTIONS — so both declared
   * checks were inert and no type error could say so. The union makes an
   * unrecognised check a compile error, and `PEER_CHECKS` (keyed on the same
   * union) makes a declared-but-unimplemented check one too.
   */
  verifyPeer?: VerifyPeerDescriptor
}

// `CtxByTag` must cover exactly the `CtxBundleTag` union — else `CtxFor<Tag>`
// silently loses a tier. (No runtime cost.)
type _Assert<T extends true> = T
type _CtxByTagCoversTags = _Assert<
  keyof CtxByTag extends CtxBundleTag ? (CtxBundleTag extends keyof CtxByTag ? true : false) : false
>
export type { _CtxByTagCoversTags }
