/**
 * Story 1.5 — the router chokepoint (AD-6). The SINGLE path an inbound message
 * takes, in a fixed fail-closed order. Today it is BUILT and exhaustively tested
 * but NOT consumed: the legacy `switch` in `background.ts` still drives every
 * dispatch (AD-12 shim-first). Stories 1.9+ flip individual `case`s to delegate
 * here; the real `buildBundle`/`resolveSender` wiring is the composition root
 * (Story 1.13). This module has zero importers outside its tests.
 *
 * Fixed order (FR16a), each stage fail-closed (FR16b):
 *   1 normalize origin (from `sender`, NEVER `payload.origin`)
 *   2 resolve route            → fail 'unknown-type'
 *   3 allowFrom                → fail 'forbidden-origin' | 'forbidden-sender'
 *   (idempotency read)         → fail 'replayed' | 'port-dropped'   (FR16d seam)
 *   4 validate (parse, not cast) → fail 'invalid-payload'
 *   5 build scoped bundle
 *   6 verifyPeer (if declared) → fail 'peer-verification-failed'
 *   7 handle                   → fail 'handler-error'
 *   8 response wrap            → ok(data); mark consumed
 *
 * Untrusted input is PARSED, not cast (FR16c): a handler only ever sees the output
 * of its own `route.validate`, never the raw `message.payload`.
 *
 * Pure module (NFR-3, MV3/CSP): no `chrome.*` and no side effects at import time —
 * the injected `resolveSender` reads `chrome` lazily, inside a call.
 */
import { MESSAGE_ROUTES } from './routes'
import type { MessageType } from './message-types'
import type { AllowFromDescriptor, CtxBundleTag, CtxFor, Route } from './route'
import { ok, fail, type Response } from './response'
import type { Pending } from '@/background/ports/ports'
import { getSenderOrigin, isExtensionSender } from '@/utils/message-guard'

/** The wire shape the router accepts. `id` (optional) keys the idempotency seam. */
export interface InboundMessage {
  type: string
  payload?: unknown
  id?: string
}

/** Where the sender is, and what kind of context it is — resolved from `sender`. */
export type SenderKind = 'extension' | 'web'
export interface ResolvedSender {
  /** Canonical origin (AD-15), or null when it cannot be trusted/determined. */
  origin: string | null
  kind: SenderKind
}

/** The counterparty-verify seam (AD-9). Epic 2 supplies the real resolver. */
type VerifyPeer = (payload: unknown, ctx: unknown) => Promise<boolean>

export interface DispatchDeps {
  /**
   * Builds the capability-scoped ctx for a route's tag. REQUIRED — 1.5 cannot
   * supply a real one (that is the composition root, Story 1.13). The signature
   * references `CtxFor`, so a factory that returns the wrong bundle for a tag
   * fails to type-check (single-source, AD-6).
   */
  buildBundle: <T extends CtxBundleTag>(tag: T) => CtxFor<T>
  /** The route registry. Defaults to the real `MESSAGE_ROUTES`. */
  routes?: { [K in MessageType]: Route<K> }
  /** Resolves `{origin, kind}` from a raw sender. Defaults to the message-guard impl. */
  resolveSender?: (sender: chrome.runtime.MessageSender | undefined) => ResolvedSender
  /** Idempotency store (AD-4). When absent, the replay seam is inert. */
  pending?: Pending
}

/** Default stage-1: trust only Chrome-populated sender fields (never payload). */
function defaultResolveSender(sender: chrome.runtime.MessageSender | undefined): ResolvedSender {
  return {
    origin: getSenderOrigin(sender),
    kind: isExtensionSender(sender) ? 'extension' : 'web',
  }
}

/** True only for a member of `routes` — `hasOwnProperty` so `__proto__` etc. miss. */
function isKnownType(
  type: string,
  routes: { [K in MessageType]: Route<K> },
): type is MessageType {
  return Object.prototype.hasOwnProperty.call(routes, type)
}

/**
 * Stage 3. Empty descriptor admits zero (fail-closed). A null origin is rejected
 * outright — never allowed to coincide with an empty `origins` list (fail-open).
 * Origin is checked before sender kind; the two produce distinct codes.
 */
function checkAllowFrom(
  desc: AllowFromDescriptor,
  s: ResolvedSender,
): 'ok' | 'forbidden-origin' | 'forbidden-sender' {
  if (s.origin === null || !desc.origins.includes(s.origin)) return 'forbidden-origin'
  if (!desc.senders.includes(s.kind)) return 'forbidden-sender'
  return 'ok'
}

export async function dispatch(
  message: InboundMessage,
  sender: chrome.runtime.MessageSender | undefined,
  deps: DispatchDeps,
): Promise<Response<unknown>> {
  const routes = deps.routes ?? MESSAGE_ROUTES
  const resolveSender = deps.resolveSender ?? defaultResolveSender

  // 1 — normalize origin (Chrome-populated sender only, never payload.origin)
  const resolved = resolveSender(sender)

  // 2 — resolve route / fail-closed on unknown type
  if (!isKnownType(message.type, routes)) return fail('unknown-type')
  const route = routes[message.type] as Route<MessageType>

  // 3 — allowFrom (per-route data, so it must follow route resolution — AD-7)
  const authz = checkAllowFrom(route.allowFrom, resolved)
  if (authz !== 'ok') return fail(authz)

  // idempotency read (FR16d seam): a consumed row is a replay; a store that
  // cannot answer means we cannot guarantee idempotency → fail-closed. Both run
  // BEFORE any effect (before validate/build/handle).
  if (message.id && deps.pending) {
    let row
    try {
      row = await deps.pending.get(message.id)
    } catch {
      return fail('port-dropped')
    }
    if (row?.consumed) return fail('replayed')
  }

  // 4 — validate (parse, not cast). The handler only ever sees this output.
  let validated: unknown
  try {
    validated = route.validate(message.payload)
  } catch {
    return fail('invalid-payload')
  }

  // 5 — build the capability-scoped bundle for this route's tier
  let ctx: CtxFor<CtxBundleTag>
  try {
    ctx = deps.buildBundle(route.bundle)
  } catch {
    return fail('handler-error')
  }

  // 6 — verifyPeer, if the route declares one (router-owned, AD-9)
  if (typeof route.verifyPeer === 'function') {
    let peerOk: boolean
    try {
      peerOk = await (route.verifyPeer as VerifyPeer)(validated, ctx)
    } catch {
      return fail('peer-verification-failed')
    }
    if (!peerOk) return fail('peer-verification-failed')
  }

  // 7 — handle the validated payload with the scoped ctx
  let data: unknown
  try {
    data = await route.handle(validated as never, ctx)
  } catch {
    return fail('handler-error')
  }

  // 8 — response wrap; seal idempotency. A failure to mark consumed leaves the
  // request replayable, so surface it as a dropped port rather than a false ok.
  if (message.id && deps.pending) {
    try {
      await deps.pending.markConsumed(message.id)
    } catch {
      return fail('port-dropped')
    }
  }
  return ok(data)
}
