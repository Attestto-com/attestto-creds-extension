/**
 * Story 1.13 Phase 1a — the in-memory `pending` adapter (AD-4). Consolidates the
 * eight closure `Map`s the legacy `background.ts` held behind ONE port so a handler
 * reaches a pending row only through `ConsentCtx.pending` (not a captured `Map`).
 *
 * `takePending` is ATOMIC-consuming (party F3): two concurrent takes of one id must
 * yield exactly one winner, or two APPROVEs double-sign. Atomicity survives an
 * internal `await` (which 1.15's `chrome.storage.session` will introduce) via a
 * serialization chain — takes run one-at-a-time, so only the first sees the row.
 * `takePending` DELETES the row and never touches `consumed`: single-writer on
 * `consumed` is the router's idempotency wrap (AD-6 stage 8), never a handler.
 *
 * Phase 1a scope: interface + in-memory adapter + the consuming/atomic SEAM only.
 * Persistence across SW restart is Story 1.15; any fail-closed POLICY (TTL, expiry,
 * branching on `consumed`) is Story 1.16 — neither belongs here.
 */
import type { Pending, PendingRow } from '@/background/ports/ports'

export interface MemoryPendingOptions {
  /**
   * Test-only: force a microtask gap between the read and the delete inside the
   * serialized critical section, modelling 1.15's async `storage.session`. The
   * adapter stays atomic BECAUSE the gap sits inside the lock — proof the lock, not
   * the single event loop, is what prevents the double-take.
   */
  simulateGap?: boolean
}

export function createMemoryPending(opts: MemoryPendingOptions = {}): Pending {
  const store = new Map<string, PendingRow>()
  // Serialization chain: each mutating op awaits the previous, so `takePending`'s
  // read+delete is indivisible even with an `await` between the two.
  let lock: Promise<void> = Promise.resolve()

  function serialize<T>(critical: () => Promise<T>): Promise<T> {
    const result = lock.then(critical)
    // Advance the chain regardless of this op's success — never let a rejection
    // wedge every later take.
    lock = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    async put(row: PendingRow): Promise<void> {
      store.set(row.id, { ...row })
    },

    async get(id: string): Promise<PendingRow | null> {
      const row = store.get(id)
      return row ? { ...row } : null
    },

    async markConsumed(id: string): Promise<void> {
      const row = store.get(id)
      if (row) store.set(id, { ...row, consumed: true })
    },

    takePending(id: string): Promise<PendingRow | null> {
      return serialize(async () => {
        const row = store.get(id) ?? null
        if (opts.simulateGap) await Promise.resolve()
        if (row) store.delete(id)
        return row ? { ...row } : null
      })
    },
  }
}
