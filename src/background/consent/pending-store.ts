/**
 * Story 1.15 — pending consent that survives a service-worker restart.
 *
 * Every pending row lived in a `Map` inside `defineBackground()`. MV3 kills the
 * worker after ~30 seconds idle, and a consent flow is *defined* by waiting for a
 * human: open an approval window, wait, the worker dies, the user clicks Approve,
 * and the row it refers to no longer exists. The page got "No pending request"
 * for an approval the user genuinely gave.
 *
 * Rows now live in `chrome.storage.session` — the same area as the session key,
 * so they outlive the worker and die with the browser, which is the correct
 * lifetime for a consent nobody has answered yet.
 *
 * ── Atomicity ────────────────────────────────────────────────────────────────
 *
 * `takePending` must be indivisible: two APPROVEs racing for one id must not both
 * win, or the user signs twice for one consent. `chrome.storage` offers no
 * compare-and-swap, and both halves of get-then-remove are async, so the
 * indivisibility is supplied here by a single-writer queue: every operation on a
 * flow is chained onto the previous one, so no two interleave.
 *
 * That is sound rather than a workaround, and the reason is worth stating: MV3
 * runs exactly ONE service-worker instance per extension. There is no second
 * writer to lose a race with. If that ever stops being true, this comment is the
 * thing that has to be revisited — hence the explicit note rather than a silent
 * assumption.
 *
 * ── Staleness ────────────────────────────────────────────────────────────────
 *
 * A row also carries `createdAt`, and one older than the backstop is treated as
 * absent and pruned. Persistence must not resurrect consent: the approval window
 * for a row that old is long gone, so an APPROVE naming it did not come from the
 * window the user was shown.
 *
 * ── What does NOT persist ────────────────────────────────────────────────────
 *
 * `unregister` — the hook that disarms an approval window's cleanup — is a
 * closure over worker-local state (`windowCleanups`, a `setTimeout` handle). It
 * cannot be serialized and it should not be: after a restart there is no
 * registered cleanup and no timer to disarm, so the correct value is "absent".
 * It is kept in a worker-local side table, keyed by the same id.
 */
import type { PendingRow, Pending } from '@/background/ports/ports'
import { PENDING_REQUEST_BACKSTOP_MS } from './approval-window'

/** What actually goes to storage. `PendingRow` plus the staleness stamp. */
export interface StoredPendingRow extends PendingRow {
  createdAt: number
}

/** The storage surface. Injected so the spec runs without `chrome`. */
export interface PendingStorage {
  get(key: string): Promise<Record<string, unknown>>
  set(entries: Record<string, unknown>): Promise<void>
}

export interface PendingStoreOptions {
  /** Distinguishes flows; becomes part of the storage key. */
  flow: string
  storage: PendingStorage
  now(): number
  /** Rows older than this are absent. Defaults to the approval-window backstop. */
  maxAgeMs?: number
}

export const PENDING_KEY_PREFIX = 'attestto_ext_pending_'

export function pendingStorageKey(flow: string): string {
  return `${PENDING_KEY_PREFIX}${flow}`
}

/** `chrome.storage.session` behind the `PendingStorage` seam. */
export function chromePendingStorage(): PendingStorage {
  return {
    get: (key) => chrome.storage.session.get(key),
    set: (entries) => chrome.storage.session.set(entries),
  }
}

export function createPendingStore(options: PendingStoreOptions): Pending {
  const { flow, storage, now } = options
  const maxAgeMs = options.maxAgeMs ?? PENDING_REQUEST_BACKSTOP_MS
  const key = pendingStorageKey(flow)

  /**
   * The single-writer queue. Every operation appends to this chain, so a second
   * caller cannot observe storage between another's read and its write.
   * `.catch` keeps one failed operation from poisoning the chain for the rest.
   */
  let queue: Promise<unknown> = Promise.resolve()

  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const run = queue.then(operation, operation)
    queue = run.catch(() => undefined)
    return run
  }

  async function readAll(): Promise<Record<string, StoredPendingRow>> {
    const got = await storage.get(key)
    const rows = got[key]
    return rows && typeof rows === 'object' ? (rows as Record<string, StoredPendingRow>) : {}
  }

  /**
   * A row is live only if its age is inside the window AND non-negative. A row
   * stamped in the future means the clock moved backwards (NTP correction,
   * user change) while it was pending, and an age that goes negative would
   * otherwise extend the row's life by however far the clock jumped. Fail
   * closed: the cost of dropping a pending consent is one more user click; the
   * cost of keeping a stale one approvable is a consent nobody is watching.
   */
  function fresh(row: StoredPendingRow | undefined): row is StoredPendingRow {
    if (!row || typeof row.createdAt !== 'number') return false
    const age = now() - row.createdAt
    return age >= 0 && age < maxAgeMs
  }

  /** Drop stale rows whenever we are already writing. Keeps the record bounded. */
  function withoutStale(rows: Record<string, StoredPendingRow>): Record<string, StoredPendingRow> {
    const kept: Record<string, StoredPendingRow> = {}
    for (const [id, row] of Object.entries(rows)) if (fresh(row)) kept[id] = row
    return kept
  }

  return {
    put: (row) =>
      serialize(async () => {
        const rows = withoutStale(await readAll())
        rows[row.id] = { ...row, createdAt: now() }
        await storage.set({ [key]: rows })
      }),

    get: (id) =>
      serialize(async () => {
        const row = (await readAll())[id]
        if (!fresh(row)) return null
        const { createdAt: _stamp, ...pending } = row
        return pending
      }),

    markConsumed: (id) =>
      serialize(async () => {
        const rows = withoutStale(await readAll())
        const row = rows[id]
        if (!row) return
        rows[id] = { ...row, consumed: true }
        await storage.set({ [key]: rows })
      }),

    takePending: (id) =>
      serialize(async () => {
        // Read and remove inside ONE queued operation. Nothing else touches this
        // flow's record between these two lines, which is what makes a second
        // concurrent APPROVE for the same id return null instead of the row.
        const rows = withoutStale(await readAll())
        const row = rows[id]
        if (!row) {
          await storage.set({ [key]: rows })
          return null
        }
        delete rows[id]
        await storage.set({ [key]: rows })
        const { createdAt: _stamp, ...pending } = row
        return pending
      }),
  }
}
