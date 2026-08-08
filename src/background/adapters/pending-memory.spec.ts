/**
 * Story 1.13 Phase 1a — the in-memory `pending` adapter, and the ATOMIC-consume
 * seam `takePending` (party F3: Vex + Dana + Redline, 2026-08-08).
 *
 * The load-bearing referent is NOT "a second take misses" (that passes a broken
 * `get → await → delete`, the founding sin). It is: two CONCURRENT takes of one id
 * yield EXACTLY ONE winner. A non-atomic impl double-signs; MV3's single loop
 * interleaves at every `await`. `simulateGap` forces 1.15's future await-gap so the
 * concurrent test bites today (an in-memory map has no real gap of its own).
 *
 * takePending DELETES the row; it MUST NOT set `consumed` — single-writer on
 * `consumed` stays the router (AD-6 stage 8, mirrors AD-14). Asserted directly.
 */
import { describe, it, expect } from 'vitest'
import { createMemoryPending } from './pending-memory'
import type { PendingRow } from '@/background/ports/ports'

const row = (id: string): PendingRow => ({ id, consumed: false, payload: { n: id } })

describe('createMemoryPending — put/get', () => {
  it('get returns a stored row, null for an unknown id', async () => {
    const p = createMemoryPending()
    await p.put(row('a'))
    expect(await p.get('a')).toEqual(row('a'))
    expect(await p.get('missing')).toBeNull()
  })
})

describe('takePending — atomic consume', () => {
  it('returns the row on first take, then null (consumed)', async () => {
    const p = createMemoryPending()
    await p.put(row('a'))
    const first = await p.takePending('a')
    expect(first).toEqual(row('a')) // first SUCCEEDS — the miss below is consumption, not a dead map
    expect(await p.takePending('a')).toBeNull()
    expect(await p.get('a')).toBeNull() // the row is gone
  })

  it('two CONCURRENT takes of one id yield EXACTLY ONE winner (no double-sign)', async () => {
    // Force the future 1.15 await-gap between get and delete.
    const p = createMemoryPending({ simulateGap: true })
    await p.put(row('a'))
    const [x, y] = await Promise.all([p.takePending('a'), p.takePending('a')])
    const winners = [x, y].filter((r): r is PendingRow => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toEqual(row('a'))
  })

  it('NON-VACUITY: a non-atomic get→await→delete would let BOTH win under the gap', async () => {
    // Prove the concurrent assertion bites: model the mutation the guard forbids.
    const store = new Map<string, PendingRow>([['a', row('a')]])
    const nonAtomicTake = async (id: string): Promise<PendingRow | null> => {
      const r = store.get(id) ?? null
      await Promise.resolve() // the await-gap a broken impl introduces
      store.delete(id)
      return r
    }
    const [x, y] = await Promise.all([nonAtomicTake('a'), nonAtomicTake('a')])
    const winners = [x, y].filter((r): r is PendingRow => r !== null)
    expect(winners).toHaveLength(2) // BOTH win — this is the double-sign the real adapter must prevent
  })

  it('takePending DELETES but MUST NOT set `consumed` (single-writer = router)', async () => {
    const p = createMemoryPending()
    await p.put(row('a'))
    await p.put(row('b'))
    const taken = await p.takePending('a')
    expect(taken?.consumed).toBe(false) // the returned row was never flipped to consumed
    // an untouched sibling row keeps consumed:false — takePending touched no flag
    expect((await p.get('b'))?.consumed).toBe(false)
  })

  it('takePending returns null for an unknown id (no throw)', async () => {
    const p = createMemoryPending()
    expect(await p.takePending('nope')).toBeNull()
  })
})

describe('markConsumed — router idempotency (unchanged by takePending)', () => {
  it('flips consumed on the stored row', async () => {
    const p = createMemoryPending()
    await p.put(row('a'))
    await p.markConsumed('a')
    expect((await p.get('a'))?.consumed).toBe(true)
  })
})
