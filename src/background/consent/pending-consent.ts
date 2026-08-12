/**
 * Story 1.13 Phase 7 — the pending-consent registry.
 * Story 1.15 — now backed by a persisted flow instead of an in-memory `Map`.
 *
 * Five consent flows (credential offer, document signing, auth, Attestto PDF,
 * payment, CHAPI) each answered a `*_GET_PENDING` and a `*_DENY` message with
 * their own copy of the same two algorithms. The DENY copy is the one that
 * matters: it must disarm the approval window's cleanup, or the window closing
 * afterwards reports a SECOND cancellation to a page that was already told. And
 * it must be idempotent, because a page told twice that the user declined is a
 * page that can be told the opposite twice.
 *
 * Story 1.15 moved the ordering guarantee from "call these in the right order"
 * to "there is only one winner". `flow.take` atomically claims the row and
 * disarms the window; a second DENY, or a DENY racing the window's own cleanup,
 * gets `null` and reports nothing. The old version relied on a `has`/`delete`
 * pair being uninterrupted, which held only because both ran synchronously — an
 * assumption that could not survive storage-backed rows.
 *
 * Reachability note (checked, not assumed): the manifest declares no
 * `externally_connectable`, and the content-script bridge forwards only a fixed
 * allowlist of message types — neither `*_GET_PENDING` nor `*_DENY` is in it. So
 * these are reachable from extension contexts only, which is why `peek` may
 * return the whole row.
 */
import type { PendingFlow } from './pending-flow'

export type PeekResult<T> = { ok: true; request: T } | { ok: false; error: string }

export interface PendingConsent<T> {
  /** Answer a `*_GET_PENDING`. */
  peek(id: string | undefined): Promise<PeekResult<T>>
  /**
   * Answer a `*_DENY`: claim the row, disarm the approval window, tell the page.
   * A no-op when the row is absent — already approved, already denied, or never
   * existed — so it can never report a denial twice.
   */
  deny(id: string | undefined): Promise<void>
}

export interface PendingConsentOptions<T> {
  flow: PendingFlow<T>
  /** The `error` string a `peek` miss answers with. Flow-specific, user-visible in logs. */
  notFound: string
  /** Report the denial to the originating page. Called at most once per row. */
  reportDenied: (row: T) => void
}

export function createPendingConsent<T>(options: PendingConsentOptions<T>): PendingConsent<T> {
  const { flow, notFound, reportDenied } = options

  return {
    async peek(id) {
      const request = await flow.peek(id)
      return request ? { ok: true, request } : { ok: false, error: notFound }
    },

    async deny(id) {
      const row = await flow.take(id)
      if (!row) return
      reportDenied(row)
    },
  }
}
