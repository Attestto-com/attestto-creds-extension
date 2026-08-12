/**
 * Story 1.16 — an APPROVE for a missing or already-consumed consent fails closed.
 *
 * FR7 is explicit that the proof must be DOUBLE-PROCESS DETECTION, not the
 * absence of an exception. So the referent throughout is a counter of how many
 * times the EFFECT ran — the thing that signs, mints, or pays — never the
 * response object. A guard can return the right error and still have run the
 * effect; only the counter can tell the difference.
 *
 * The effect here also records what it saw, so "ran once" and "ran once with the
 * right row" are separate assertions.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPendingFlow, approveRejection, ALREADY_PROCESSED_ERROR } from './pending-flow'
import { createPendingStore, type PendingStorage } from './pending-store'
import { createPendingConsent } from './pending-consent'
import { PENDING_REQUEST_BACKSTOP_MS } from './approval-window'

interface Row {
  requestId: string
  amount: number
}

const ROW: Row = { requestId: 'req-1', amount: 42 }

let data: Record<string, unknown>
let clock: number

const storage: PendingStorage = {
  get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
  set: async (entries) => {
    data = { ...data, ...structuredClone(entries) }
  },
}

function worker() {
  return createPendingFlow<Row>(createPendingStore({ flow: 'pay', storage, now: () => clock }))
}

/** The effect a real APPROVE would run: signing, minting, paying. */
function effect() {
  const ran: Row[] = []
  return {
    ran,
    run: async (row: Row) => {
      ran.push(row)
      return `signature-for-${row.requestId}`
    },
  }
}

beforeEach(() => {
  data = {}
  clock = 1_000_000
})

describe('the effect cannot run without a live consent', () => {
  it('runs exactly once for one consent', async () => {
    const flow = worker()
    const e = effect()
    await flow.put('req-1', ROW)

    await flow.approve('req-1', e.run)

    expect(e.ran).toEqual([ROW])
  })

  it('a REPLAYED approve does not run the effect a second time', async () => {
    const flow = worker()
    const e = effect()
    await flow.put('req-1', ROW)

    const first = await flow.approve('req-1', e.run)
    const second = await flow.approve('req-1', e.run)

    expect(e.ran).toHaveLength(1) // ← the assertion FR7 asks for
    expect(first).toEqual({ ok: true, value: 'signature-for-req-1' })
    expect(second).toEqual({ ok: false, reason: 'alreadyConsumed' })
  })

  it('a replay across a worker restart still does not run the effect', async () => {
    const e = effect()
    await worker().put('req-1', ROW)
    await worker().approve('req-1', e.run)

    // The tombstone is in storage, so the next worker sees it too.
    await worker().approve('req-1', e.run)

    expect(e.ran).toHaveLength(1)
  })

  it('TEN concurrent approves run the effect ONCE', async () => {
    const flow = worker()
    const e = effect()
    await flow.put('req-1', ROW)

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => flow.approve('req-1', e.run)),
    )

    expect(e.ran).toHaveLength(1)
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
  })

  it('an approve for an id that never existed runs nothing', async () => {
    const e = effect()
    expect(await worker().approve('ghost', e.run)).toEqual({ ok: false, reason: 'missing' })
    expect(e.ran).toEqual([])
  })

  it('an approve with no id at all runs nothing — no default-accept', async () => {
    const flow = worker()
    const e = effect()
    await flow.put('req-1', ROW)

    expect(await flow.approve(undefined, e.run)).toEqual({ ok: false, reason: 'missing' })
    expect(await flow.approve('', e.run)).toEqual({ ok: false, reason: 'missing' })
    expect(e.ran).toEqual([])
    // …and the real row is untouched.
    expect(await flow.peek('req-1')).toEqual(ROW)
  })

  it('an approve for a DENIED consent runs nothing', async () => {
    const flow = worker()
    const e = effect()
    await flow.put('req-1', ROW)
    await createPendingConsent<Row>({ flow, notFound: 'x', reportDenied: () => {} }).deny('req-1')

    expect(await flow.approve('req-1', e.run)).toEqual({ ok: false, reason: 'missing' })
    expect(e.ran).toEqual([])
  })

  it('an approve for a consent that aged out runs nothing', async () => {
    const flow = worker()
    const e = effect()
    await flow.put('req-1', ROW)
    clock += PENDING_REQUEST_BACKSTOP_MS + 1

    expect(await flow.approve('req-1', e.run)).toEqual({ ok: false, reason: 'missing' })
    expect(e.ran).toEqual([])
  })

  it('rejects BEFORE the effect, not after — the effect is never entered', async () => {
    // Distinguishes "guarded" from "ran it then discarded the result". A thrown
    // effect would surface here if it were reached at all.
    const flow = worker()
    let entered = false
    const boom = async () => {
      entered = true
      throw new Error('the effect must not be reachable')
    }

    await expect(flow.approve('ghost', boom)).resolves.toEqual({ ok: false, reason: 'missing' })
    expect(entered).toBe(false)
  })
})

describe('one consent yields exactly one outcome', () => {
  it('a DENY after an approve reports nothing — the page is not told twice', async () => {
    // Approve signs and answers the page. If deny could still take the tombstone,
    // the same page would then be told the user declined.
    const flow = worker()
    const told: string[] = []
    const consent = createPendingConsent<Row>({
      flow,
      notFound: 'x',
      reportDenied: (row) => told.push(`declined:${row.requestId}`),
    })
    await flow.put('req-1', ROW)

    await flow.approve('req-1', async () => 'signed')
    await consent.deny('req-1')

    expect(told).toEqual([])
  })

  it('the approval window closing after an approve cancels nothing', async () => {
    // The window's cleanup calls `take`; a consumed row must not be takeable.
    const flow = worker()
    await flow.put('req-1', ROW)
    await flow.approve('req-1', async () => 'signed')

    expect(await flow.take('req-1')).toBeNull()
  })

  it('an approve after a deny is missing, not claimed', async () => {
    const flow = worker()
    await flow.put('req-1', ROW)
    await flow.take('req-1') // the deny path

    expect(await flow.approve('req-1', async () => 'signed')).toEqual({
      ok: false,
      reason: 'missing',
    })
  })
})

describe('the two rejections stay distinguishable', () => {
  it('a replay is reported as already-processed, not as missing', () => {
    expect(approveRejection('alreadyConsumed', 'No pending payment request')).toEqual({
      ok: false,
      error: ALREADY_PROCESSED_ERROR,
    })
  })

  it('a stale click keeps the flow-specific message', () => {
    expect(approveRejection('missing', 'No pending payment request')).toEqual({
      ok: false,
      error: 'No pending payment request',
    })
  })

  it('the two messages are not the same string — a replay is detectable', () => {
    // Collapsing them would satisfy "no double processing" while making FR7's
    // detection impossible. This is the assertion that keeps them apart.
    const replay = approveRejection('alreadyConsumed', 'No pending payment request')
    const stale = approveRejection('missing', 'No pending payment request')
    expect(replay.error).not.toBe(stale.error)
  })
})

/**
 * Everything above proves the guard works. This proves the worker USES it —
 * the SOC-144 lesson: a guard with green tests and no caller is dead code that
 * looks covered. `background.ts` cannot be booted from a spec (it lives inside
 * `defineBackground()`, and WXT would treat a spec under `entrypoints/` as an
 * entrypoint), so the call sites are asserted against the source.
 */
describe('every APPROVE case goes through the guard', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/entrypoints/background.ts'), 'utf8')

  const FLOWS = [
    'pendingSigningRequests',
    'pendingAuthRequests',
    'pendingAttesttoPdfRequests',
    'pendingPaymentRequests',
    'pendingChapiRawRequests',
  ]

  it.each(FLOWS)('%s approves through the chokepoint', (flow) => {
    expect(source).toContain(`${flow}.approve(`)
  })

  it('no APPROVE case reaches its effect via a bare take', () => {
    // `take` is the DENY/window-cleanup path. An APPROVE using it would consume
    // the row without leaving a tombstone, so a replay would read as "missing"
    // and double-processing would stop being detectable.
    for (const flow of FLOWS) expect(source).not.toContain(`${flow}.take(`)
  })

  it('every rejection is reported, not swallowed', () => {
    // One `approveRejection` per guarded case, or a rejected approve would leave
    // the approval window waiting with no answer at all.
    expect(source.match(/approveRejection\(outcome\.reason/g)).toHaveLength(FLOWS.length)
  })

  it('the credential-offer accept path claims atomically too', () => {
    expect(source).toContain('pendingOffers.take(notificationId)')
  })
})

describe('the tombstone is bounded', () => {
  it('is pruned once it ages out, so replay markers do not accumulate', async () => {
    const flow = worker()
    await flow.put('req-1', ROW)
    await flow.approve('req-1', async () => 'signed')
    expect(await flow.approve('req-1', async () => 'x')).toMatchObject({ reason: 'alreadyConsumed' })

    clock += PENDING_REQUEST_BACKSTOP_MS + 1
    await flow.put('req-2', { requestId: 'req-2', amount: 1 }) // any write prunes

    expect(Object.keys(data['attestto_ext_pending_pay'] as object)).toEqual(['req-2'])
  })

  it('an aged-out tombstone reads as missing rather than as a replay', async () => {
    // Honest about the limit: past the backstop we can no longer tell a replay
    // from a stale click. The approval window is long gone by then, so both
    // answers are a rejection either way.
    const flow = worker()
    await flow.put('req-1', ROW)
    await flow.approve('req-1', async () => 'signed')

    clock += PENDING_REQUEST_BACKSTOP_MS + 1

    expect(await flow.approve('req-1', async () => 'x')).toEqual({ ok: false, reason: 'missing' })
  })
})
