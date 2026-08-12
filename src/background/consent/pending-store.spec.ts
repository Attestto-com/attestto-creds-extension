/**
 * Story 1.15 — the persisted pending store.
 *
 * The referent is a fake storage object whose CONTENTS the tests read directly,
 * and — for the restart tests — a second store built fresh over the same
 * storage. That second construction is the whole point: a store that only ever
 * answers from its own memory would pass every single-instance test and lose
 * every row on the restart this story exists to survive.
 *
 * The concurrency tests deliberately gate the fake storage so two operations are
 * genuinely in flight at once. Calling `takePending` twice with an `await`
 * between them proves nothing about atomicity.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createPendingStore,
  pendingStorageKey,
  type PendingStorage,
  type StoredPendingRow,
} from './pending-store'
import { PENDING_REQUEST_BACKSTOP_MS } from './approval-window'

const FLOW = 'auth'
const KEY = pendingStorageKey(FLOW)

/** A storage fake that can be told to hold operations open. */
function fakeStorage() {
  let data: Record<string, unknown> = {}
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null

  const api: PendingStorage = {
    get: async (key) => {
      if (gate) await gate
      return key in data ? { [key]: structuredClone(data[key]) } : {}
    },
    set: async (entries) => {
      if (gate) await gate
      data = { ...data, ...structuredClone(entries) }
    },
  }

  return {
    api,
    get rows(): Record<string, StoredPendingRow> {
      return (data[KEY] as Record<string, StoredPendingRow>) ?? {}
    },
    seed(rows: Record<string, StoredPendingRow>) {
      data = { ...data, [KEY]: rows }
    },
    /** Hold every subsequent storage call until `release()`. */
    hold() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    release() {
      gate = null
      openGate?.()
      openGate = null
    },
  }
}

let clock: number
let storage: ReturnType<typeof fakeStorage>

function store(overrides: { now?: () => number } = {}) {
  return createPendingStore({
    flow: FLOW,
    storage: storage.api,
    now: overrides.now ?? (() => clock),
  })
}

beforeEach(() => {
  clock = 1_000_000
  storage = fakeStorage()
})

describe('a row survives the worker', () => {
  it('a store built fresh over the same storage reads the row back', async () => {
    await store().put({ id: 'req-1', consumed: false, payload: { nonce: 'n1' } })

    // The service worker died here. Everything in memory is gone.
    const afterRestart = store()

    expect(await afterRestart.get('req-1')).toEqual({
      id: 'req-1',
      consumed: false,
      payload: { nonce: 'n1' },
    })
  })

  it('the row reaches storage, not just the instance that wrote it', async () => {
    await store().put({ id: 'req-1', consumed: false, payload: { nonce: 'n1' } })
    expect(Object.keys(storage.rows)).toEqual(['req-1'])
  })

  it('flows do not collide — one flow cannot take another flow row', async () => {
    const auth = createPendingStore({ flow: 'auth', storage: storage.api, now: () => clock })
    const payment = createPendingStore({ flow: 'payment', storage: storage.api, now: () => clock })

    await auth.put({ id: 'shared-id', consumed: false, payload: 'auth-payload' })
    await payment.put({ id: 'shared-id', consumed: false, payload: 'payment-payload' })

    expect((await auth.get('shared-id'))?.payload).toBe('auth-payload')
    expect((await payment.takePending('shared-id'))?.payload).toBe('payment-payload')
    // Taking the payment row left the auth row alone.
    expect((await auth.get('shared-id'))?.payload).toBe('auth-payload')
  })

  it('answers null for an id that was never stored', async () => {
    expect(await store().get('nope')).toBeNull()
    expect(await store().takePending('nope')).toBeNull()
  })
})

describe('takePending is indivisible', () => {
  it('two concurrent takes for one id: exactly one wins', async () => {
    const s = store()
    await s.put({ id: 'req-1', consumed: false, payload: 'once' })

    // Both calls are in flight before either can finish.
    storage.hold()
    const first = s.takePending('req-1')
    const second = s.takePending('req-1')
    storage.release()

    const results = await Promise.all([first, second])
    const winners = results.filter((r) => r !== null)

    expect(winners).toHaveLength(1)
    expect(winners[0]?.payload).toBe('once')
  })

  it('ten concurrent takes for one id: still exactly one', async () => {
    const s = store()
    await s.put({ id: 'req-1', consumed: false, payload: 'once' })

    storage.hold()
    const takes = Array.from({ length: 10 }, () => s.takePending('req-1'))
    storage.release()

    expect((await Promise.all(takes)).filter(Boolean)).toHaveLength(1)
  })

  it('a take removes the row from storage, not just from a cache', async () => {
    const s = store()
    await s.put({ id: 'req-1', consumed: false, payload: 'once' })
    await s.takePending('req-1')

    expect(storage.rows['req-1']).toBeUndefined()
    // And a worker that restarts cannot find it either.
    expect(await store().get('req-1')).toBeNull()
  })

  it('concurrent puts on one flow do not lose each other', async () => {
    // The read-modify-write hazard: without the queue, the second put reads the
    // record before the first wrote it and clobbers it.
    const s = store()

    storage.hold()
    const puts = [
      s.put({ id: 'a', consumed: false, payload: 1 }),
      s.put({ id: 'b', consumed: false, payload: 2 }),
      s.put({ id: 'c', consumed: false, payload: 3 }),
    ]
    storage.release()
    await Promise.all(puts)

    expect(Object.keys(storage.rows).sort()).toEqual(['a', 'b', 'c'])
  })

  it('a failed operation does not wedge the queue for the next caller', async () => {
    const s = store()
    const broken: PendingStorage = {
      get: async () => {
        throw new Error('storage unavailable')
      },
      set: async () => {},
    }
    const flaky = createPendingStore({ flow: FLOW, storage: broken, now: () => clock })

    await expect(flaky.get('x')).rejects.toThrow('storage unavailable')
    // The healthy store shares no queue, but the flaky one must still accept work.
    await expect(flaky.get('y')).rejects.toThrow('storage unavailable')
    await s.put({ id: 'ok', consumed: false, payload: null })
    expect(storage.rows['ok']).toBeDefined()
  })
})

describe('markConsumed', () => {
  it('sets the field that AD-6 idempotency reads', async () => {
    const s = store()
    await s.put({ id: 'req-1', consumed: false, payload: 'p' })
    await s.markConsumed('req-1')

    expect((await store().get('req-1'))?.consumed).toBe(true)
  })

  it('is a no-op on a row that is not there rather than creating one', async () => {
    await store().markConsumed('ghost')
    expect(storage.rows['ghost']).toBeUndefined()
  })

  it('does NOT remove the row — consumed and taken are different states', async () => {
    const s = store()
    await s.put({ id: 'req-1', consumed: false, payload: 'p' })
    await s.markConsumed('req-1')

    expect(await s.get('req-1')).not.toBeNull()
  })
})

describe('persistence must not resurrect consent', () => {
  it('a row older than the backstop reads as absent', async () => {
    await store().put({ id: 'old', consumed: false, payload: 'p' })
    clock += PENDING_REQUEST_BACKSTOP_MS + 1

    expect(await store().get('old')).toBeNull()
    expect(await store().takePending('old')).toBeNull()
  })

  it('a row just inside the backstop is still live', async () => {
    await store().put({ id: 'recent', consumed: false, payload: 'p' })
    clock += PENDING_REQUEST_BACKSTOP_MS - 1

    expect(await store().get('recent')).not.toBeNull()
  })

  it('stale rows are pruned rather than accumulating for the browser session', async () => {
    const s = store()
    await s.put({ id: 'old', consumed: false, payload: 'p' })
    clock += PENDING_REQUEST_BACKSTOP_MS + 1
    await s.put({ id: 'new', consumed: false, payload: 'p' })

    expect(Object.keys(storage.rows)).toEqual(['new'])
  })

  it('a clock that jumps backwards drops the row rather than extending it', async () => {
    // Session storage survives a system clock change. If age were allowed to go
    // negative the row would outlive the backstop by however far the clock
    // jumped, so a future-stamped row reads as absent.
    await store().put({ id: 'req-1', consumed: false, payload: 'p' })
    clock -= 60 * 60 * 1000

    expect(await store().get('req-1')).toBeNull()
  })
})

describe('a corrupt storage record is treated as empty, not as a crash', () => {
  it('survives a non-object under the flow key', async () => {
    storage.seed('garbage' as unknown as Record<string, StoredPendingRow>)
    expect(await store().get('anything')).toBeNull()
  })

  it('a row missing its stamp reads as stale rather than throwing', async () => {
    storage.seed({ broken: { id: 'broken', consumed: false, payload: 'p' } as StoredPendingRow })
    expect(await store().get('broken')).toBeNull()
  })
})

describe('the stored shape', () => {
  it('carries id and consumed — the fields AD-6 idempotency needs', async () => {
    await store().put({ id: 'req-1', consumed: false, payload: { a: 1 } })
    expect(storage.rows['req-1']).toMatchObject({ id: 'req-1', consumed: false })
  })

  it('does not leak the internal stamp back to callers', async () => {
    await store().put({ id: 'req-1', consumed: false, payload: null })
    expect(await store().get('req-1')).not.toHaveProperty('createdAt')
    expect(await store().takePending('req-1')).not.toHaveProperty('createdAt')
  })
})
