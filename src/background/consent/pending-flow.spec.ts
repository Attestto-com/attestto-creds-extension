/**
 * Story 1.15 — the pending flow: persisted row + worker-local window hook.
 *
 * The property worth proving is the SPLIT. Data has to cross a worker restart;
 * the disarm hook must not, because after a restart it would refer to a cleanup
 * registry and a timer that no longer exist. A design that persisted both would
 * pass a naive "the row survived" test and then call a stale closure.
 *
 * So "restart" here means literally building a second flow over the same
 * storage, and the tests assert what each half does across that line.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPendingFlow } from './pending-flow'
import { createPendingStore, type PendingStorage } from './pending-store'

interface Row {
  requestId: string
  senderTabId: number | null
}

let data: Record<string, unknown>

const storage: PendingStorage = {
  get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
  set: async (entries) => {
    data = { ...data, ...structuredClone(entries) }
  },
}

/** A fresh flow over the SAME storage — i.e. what the next service worker sees. */
function worker() {
  return createPendingFlow<Row>(createPendingStore({ flow: 'auth', storage, now: () => 1_000_000 }))
}

const ROW: Row = { requestId: 'req-1', senderTabId: 7 }

beforeEach(() => {
  data = {}
})

describe('data crosses the restart', () => {
  it('a row put by one worker is peekable by the next', async () => {
    await worker().put('req-1', ROW)
    expect(await worker().peek('req-1')).toEqual(ROW)
  })

  it('a row put by one worker is takeable by the next — the APPROVE that used to fail', async () => {
    await worker().put('req-1', ROW)
    expect(await worker().take('req-1')).toEqual(ROW)
  })

  it('the sender tab id survives, so the answer still reaches the page', async () => {
    await worker().put('req-1', ROW)
    expect((await worker().take('req-1'))?.senderTabId).toBe(7)
  })

  it('a row taken before the restart is gone after it', async () => {
    const before = worker()
    await before.put('req-1', ROW)
    await before.take('req-1')
    expect(await worker().peek('req-1')).toBeNull()
  })
})

describe('the window hook does NOT cross the restart', () => {
  it('the new worker has no hook to call — there is no cleanup left to disarm', async () => {
    const fired: string[] = []
    const before = worker()
    await before.put('req-1', ROW)
    before.attachUnregister('req-1', () => fired.push('stale-hook'))

    // The worker died. Its `windowCleanups` map and its setTimeout went with it.
    await worker().take('req-1')

    expect(fired).toEqual([])
  })

  it('within one worker, take DOES disarm', async () => {
    const fired: string[] = []
    const flow = worker()
    await flow.put('req-1', ROW)
    flow.attachUnregister('req-1', () => fired.push('disarmed'))

    await flow.take('req-1')

    expect(fired).toEqual(['disarmed'])
  })

  it('disarms exactly once, even if take is called again', async () => {
    const fired: string[] = []
    const flow = worker()
    await flow.put('req-1', ROW)
    flow.attachUnregister('req-1', () => fired.push('disarmed'))

    await flow.take('req-1')
    await flow.take('req-1')

    expect(fired).toEqual(['disarmed'])
  })

  it('a losing racer does NOT disarm — only the caller that won the row', async () => {
    // If a miss disarmed, a second APPROVE arriving late would silence the
    // cleanup that the real winner is relying on.
    const fired: string[] = []
    const flow = worker()
    await flow.put('req-1', ROW)
    await flow.take('req-1') // winner, consumes the hook

    flow.attachUnregister('req-1', () => fired.push('should-not-fire'))
    await flow.take('req-1') // loser

    expect(fired).toEqual([])
  })

  it('peek never disarms — the approval page loading must not defuse the cleanup', async () => {
    const fired: string[] = []
    const flow = worker()
    await flow.put('req-1', ROW)
    flow.attachUnregister('req-1', () => fired.push('disarmed'))

    await flow.peek('req-1')

    expect(fired).toEqual([])
  })
})

describe('missing ids', () => {
  it('peek and take answer null for a blank id rather than throwing', async () => {
    const flow = worker()
    expect(await flow.peek(undefined)).toBeNull()
    expect(await flow.peek('')).toBeNull()
    expect(await flow.take(undefined)).toBeNull()
    expect(await flow.take('')).toBeNull()
  })

  it('a blank-id take does not consume a real row', async () => {
    const flow = worker()
    await flow.put('req-1', ROW)
    await flow.take(undefined)
    expect(await flow.peek('req-1')).toEqual(ROW)
  })
})

describe('the stored envelope', () => {
  it('starts unconsumed — the field Story 1.16 will check', async () => {
    const store = createPendingStore({ flow: 'auth', storage, now: () => 1_000_000 })
    await createPendingFlow<Row>(store).put('req-1', ROW)
    expect(await store.get('req-1')).toMatchObject({ id: 'req-1', consumed: false })
  })

  it('hands back the payload, not the envelope', async () => {
    await worker().put('req-1', ROW)
    const taken = await worker().take('req-1')
    expect(taken).not.toHaveProperty('consumed')
    expect(taken).not.toHaveProperty('payload')
  })
})
