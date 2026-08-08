/**
 * Story 1.13 Phase 7 — the pending-consent registry.
 *
 * Five consent flows (credential offer, document signing, auth, Attestto PDF,
 * payment, CHAPI) each answered a `*_GET_PENDING` and a `*_DENY` message with
 * their own copy of the same two algorithms. The DENY copy is the one that
 * matters: it must unregister the approval window's cleanup BEFORE it purges the
 * row, or the window closing afterwards reports a SECOND cancellation to a page
 * that was already told. And it must be idempotent, because a page told twice
 * that the user declined is a page that can be told the opposite twice.
 *
 * Reachability note (checked, not assumed): the manifest declares no
 * `externally_connectable`, and the content-script bridge forwards only a fixed
 * allowlist of message types — neither `*_GET_PENDING` nor `*_DENY` is in it. So
 * these are reachable from extension contexts only, which is why `peek` may
 * return the whole row.
 */

/** The shape every pending row shares: a hook to disarm its approval window. */
export interface ConsentRow {
  unregister?: () => void
}

export type PeekResult<T> = { ok: true; request: T } | { ok: false; error: string }

export interface PendingConsent<T extends ConsentRow> {
  /** Answer a `*_GET_PENDING`. */
  peek(id: string | undefined): PeekResult<T>
  /**
   * Answer a `*_DENY`: disarm the approval window, purge the row, tell the page.
   * A no-op when the row is absent — already approved, already denied, or never
   * existed — so it can never report a denial twice.
   */
  deny(id: string | undefined): void
}

export interface PendingConsentOptions<T extends ConsentRow> {
  rows: Map<string, T>
  /** The `error` string a `peek` miss answers with. Flow-specific, user-visible in logs. */
  notFound: string
  /** Report the denial to the originating page. Called at most once per row. */
  reportDenied(row: T): void
}

export function createPendingConsent<T extends ConsentRow>(
  options: PendingConsentOptions<T>,
): PendingConsent<T> {
  const { rows, notFound, reportDenied } = options

  return {
    peek(id) {
      const request = id ? rows.get(id) : undefined
      return request ? { ok: true, request } : { ok: false, error: notFound }
    },

    deny(id) {
      const row = id ? rows.get(id) : undefined
      if (!row) return
      // Order is load-bearing: disarm first, so the approval window closing in
      // the next moment does not report a second cancellation.
      row.unregister?.()
      rows.delete(id as string)
      reportDenied(row)
    },
  }
}
