/**
 * Story 1.15 — one consent flow's pending rows, persisted plus their worker-local
 * window hook.
 *
 * `pending-store.ts` persists data. This joins that to the one piece of a pending
 * row that CANNOT be persisted: `unregister`, the closure that disarms an
 * approval window's cleanup. It closes over `windowCleanups` and a `setTimeout`
 * handle, both worker-local. After a restart there is no cleanup registered and
 * no timer running, so its correct value is "absent" — which is exactly what a
 * side table keyed by id gives you for free.
 *
 * `take` is the chokepoint every consumer goes through:
 *
 *   1. atomically remove the row (or return null if someone already did)
 *   2. disarm the approval window, so its close does not report a SECOND outcome
 *   3. hand the data back
 *
 * Doing it in that order and in one place is what makes the whole thing
 * idempotent. The previous code did `has` → `delete` as two separate steps in the
 * window-cleanup path while an APPROVE could run between them; both would then
 * think they owned the row and the page would be told twice — once approved, once
 * cancelled. There is now exactly one winner by construction.
 *
 * This is also the seam Story 1.16 hardens: an APPROVE for a missing or consumed
 * row has one function to fail closed in.
 */
import type { Pending } from '@/background/ports/ports'

export interface PendingFlow<T> {
  /** Stash a row. Overwrites any row with the same id. */
  put(id: string, data: T): Promise<void>
  /** Read without consuming — answers a `*_GET_PENDING`. */
  peek(id: string | undefined): Promise<T | null>
  /**
   * Atomically claim the row: remove it, disarm its approval window, return it.
   * `null` if it was already claimed, never existed, or has gone stale.
   */
  take(id: string | undefined): Promise<T | null>
  /**
   * Story 1.16 — the APPROVE chokepoint. Claims the row and runs `effect` ONLY
   * if the claim succeeded.
   *
   * `effect` is an argument rather than something the caller runs after checking
   * a result, and that is the whole design: there is no ordering for a call site
   * to get wrong and no way to reach the effect without the guard having passed.
   * The five APPROVE cases previously each re-implemented "look up, bail if
   * missing, then act" — five chances for one to drift into acting first.
   */
  approve<R>(id: string | undefined, effect: (row: T) => R | Promise<R>): Promise<ApproveOutcome<R>>
  /** Attach the approval window's disarm hook. Worker-local; lost on restart. */
  attachUnregister(id: string, unregister: () => void): void
}

export type ApproveOutcome<R> =
  | { ok: true; value: R }
  | { ok: false; reason: 'missing' | 'alreadyConsumed' }

/**
 * What the approval window is told when the guard rejected.
 *
 * The two reasons stay DISTINCT all the way to the caller. Collapsing them into
 * one "no pending request" would make a replayed approval indistinguishable from
 * a stale click, and FR7 asks for double-processing to be detected, not merely
 * prevented. This string is what a log or a future counter keys on.
 */
export const ALREADY_PROCESSED_ERROR = 'This request was already processed'

export function approveRejection(
  reason: 'missing' | 'alreadyConsumed',
  missingError: string,
): { ok: false; error: string } {
  return { ok: false, error: reason === 'alreadyConsumed' ? ALREADY_PROCESSED_ERROR : missingError }
}

export function createPendingFlow<T>(store: Pending): PendingFlow<T> {
  /**
   * Worker-local, deliberately. See the header: a hook that survived into a new
   * worker would refer to a cleanup registry and a timer that no longer exist.
   */
  const unregisters = new Map<string, () => void>()

  function disarm(id: string): void {
    const unregister = unregisters.get(id)
    unregisters.delete(id)
    unregister?.()
  }

  return {
    async put(id, data) {
      await store.put({ id, consumed: false, payload: data })
    },

    async peek(id) {
      if (!id) return null
      const row = await store.get(id)
      return row ? (row.payload as T) : null
    },

    async take(id) {
      if (!id) return null
      const row = await store.takePending(id)
      // Disarm only for the caller that actually won the row. Disarming on a
      // miss would let a losing racer silence the winner's cleanup.
      if (!row) return null
      disarm(id)
      return row.payload as T
    },

    async approve(id, effect) {
      // Fail closed on a blank id: an APPROVE that names nothing approves nothing.
      if (!id) return { ok: false, reason: 'missing' }

      const claim = await store.claimForProcessing(id)
      if (claim.status !== 'claimed') return { ok: false, reason: claim.status }

      // Past the guard, so this consent is ours and nobody else's. Disarm the
      // window before the effect runs — the effect can take seconds (a WebAuthn
      // prompt), and the backstop must not fire a cancellation underneath it.
      disarm(id)
      return { ok: true, value: await effect(claim.row.payload as T) }
    },

    attachUnregister(id, unregister) {
      unregisters.set(id, unregister)
    },
  }
}
