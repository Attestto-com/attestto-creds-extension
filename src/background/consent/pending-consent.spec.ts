/**
 * Story 1.13 Phase 7 — the pending-consent registry.
 * Story 1.15 — over a persisted flow instead of an in-memory `Map`.
 *
 * Two properties carry the security weight, and both are about ORDER and COUNT
 * rather than about any single call happening:
 *
 *   - deny disarms the approval window BEFORE reporting, so a window closing
 *     right after a deny cannot report a second cancellation.
 *   - deny is idempotent: whatever the page is told, it is told once.
 *
 * So the assertions are on an observed event LOG — every effect in the order it
 * happened — not on "was this collaborator called". A spy that only records
 * `toHaveBeenCalled` passes for an implementation that reports twice.
 *
 * The flow underneath is the REAL `createPendingFlow` over the REAL
 * `createPendingStore`, on a fake storage object. Substituting a stub flow here
 * would leave the atomicity these properties now rest on untested at this level.
 */
import { describe, it, expect } from 'vitest'
import { createPendingConsent } from './pending-consent'
import { createPendingFlow } from './pending-flow'
import { createPendingStore, type PendingStorage } from './pending-store'

interface Row {
  id: string
  secret?: string
}

function memoryStorage(): PendingStorage {
  let data: Record<string, unknown> = {}
  return {
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (entries) => {
      data = { ...data, ...structuredClone(entries) }
    },
  }
}

/** A registry whose every effect lands in one ordered log. */
async function registry(rows: Row[] = [{ id: 'r1' }]) {
  const log: string[] = []
  const flow = createPendingFlow<Row>(
    createPendingStore({ flow: 'test', storage: memoryStorage(), now: () => 1_000_000 }),
  )
  for (const row of rows) {
    await flow.put(row.id, row)
    flow.attachUnregister(row.id, () => log.push(`unregister:${row.id}`))
  }
  const consent = createPendingConsent<Row>({
    flow,
    notFound: 'No pending request found',
    reportDenied: (row) => log.push(`reported:${row.id}`),
  })
  return { consent, flow, log }
}

describe('peek', () => {
  it('returns the row for a live request', async () => {
    const { consent } = await registry()
    expect(await consent.peek('r1')).toEqual({ ok: true, request: { id: 'r1' } })
  })

  it('reports not-found for an unknown id, with the flow-specific message', async () => {
    const { consent } = await registry()
    expect(await consent.peek('nope')).toEqual({ ok: false, error: 'No pending request found' })
  })

  it('reports not-found rather than throwing when the message carried no id', async () => {
    const { consent } = await registry()
    expect(await consent.peek(undefined)).toEqual({ ok: false, error: 'No pending request found' })
    expect(await consent.peek('')).toEqual({ ok: false, error: 'No pending request found' })
  })

  it('does not consume the row — a peek is not a take', async () => {
    const { consent, flow } = await registry()
    await consent.peek('r1')
    await consent.peek('r1')
    expect(await flow.peek('r1')).not.toBeNull()
  })

  it("never returns another flow's row", async () => {
    const { consent } = await registry([{ id: 'r1' }, { id: 'r2', secret: 'other-flow' }])
    const out = await consent.peek('r1')
    expect(out).toMatchObject({ ok: true })
    expect(JSON.stringify(out)).not.toContain('other-flow')
  })
})

describe('deny', () => {
  it('disarms the approval window BEFORE reporting, so a late window-close is a no-op', async () => {
    const { consent, log } = await registry()
    await consent.deny('r1')
    expect(log).toEqual(['unregister:r1', 'reported:r1'])
  })

  it('purges the row', async () => {
    const { consent, flow } = await registry()
    await consent.deny('r1')
    expect(await flow.peek('r1')).toBeNull()
  })

  it('reports EXACTLY ONCE when denied twice', async () => {
    const { consent, log } = await registry()
    await consent.deny('r1')
    await consent.deny('r1')
    expect(log.filter((e) => e.startsWith('reported'))).toEqual(['reported:r1'])
  })

  it('reports EXACTLY ONCE when two denies race', async () => {
    // Two approval windows for one id, both dismissed in the same tick. Before
    // Story 1.15 this held only because `has`/`delete` ran synchronously.
    const { consent, log } = await registry()
    await Promise.all([consent.deny('r1'), consent.deny('r1'), consent.deny('r1')])
    expect(log.filter((e) => e.startsWith('reported'))).toEqual(['reported:r1'])
  })

  it('reports nothing for a row that was already approved and taken', async () => {
    const { consent, flow, log } = await registry()
    await flow.take('r1') // the APPROVE path consumed it
    log.length = 0 // the take legitimately disarmed the window
    await consent.deny('r1')
    expect(log).toEqual([])
  })

  it('reports nothing for an unknown id or a missing one', async () => {
    const { consent, log } = await registry()
    await consent.deny('nope')
    await consent.deny(undefined)
    await consent.deny('')
    expect(log).toEqual([])
    expect(await consent.peek('r1')).toMatchObject({ ok: true })
  })

  it('denies only the named row, leaving concurrent approvals alone', async () => {
    const { consent, flow, log } = await registry([{ id: 'r1' }, { id: 'r2' }])
    await consent.deny('r1')
    expect(await flow.peek('r2')).not.toBeNull()
    expect(log).toEqual(['unregister:r1', 'reported:r1'])
  })

  it('still purges and reports for a row that never armed a window', async () => {
    const log: string[] = []
    const flow = createPendingFlow<Row>(
      createPendingStore({ flow: 'test', storage: memoryStorage(), now: () => 1_000_000 }),
    )
    await flow.put('r1', { id: 'r1' }) // no unregister hook attached
    const consent = createPendingConsent<Row>({
      flow,
      notFound: 'x',
      reportDenied: (row) => log.push(`reported:${row.id}`),
    })
    await consent.deny('r1')
    expect(await flow.peek('r1')).toBeNull()
    expect(log).toEqual(['reported:r1'])
  })

  it('hands the reporter the row itself, so a flow can route by its own fields', async () => {
    // The auth flow needs this: a `cw` request must be answered on the
    // CW_AUTH_RESPONSE channel, not the legacy AUTH_RESPONSE one.
    const seen: Row[] = []
    const flow = createPendingFlow<Row>(
      createPendingStore({ flow: 'test', storage: memoryStorage(), now: () => 1_000_000 }),
    )
    await flow.put('r1', { id: 'r1', secret: 'cw' })
    const consent = createPendingConsent<Row>({
      flow,
      notFound: 'x',
      reportDenied: (row) => seen.push(row),
    })
    await consent.deny('r1')
    expect(seen).toEqual([{ id: 'r1', secret: 'cw' }])
  })

  it('a row denied in one worker stays denied in the next', async () => {
    // Same storage, a second flow instance — the restart case.
    const storage = memoryStorage()
    const build = () =>
      createPendingFlow<Row>(createPendingStore({ flow: 'test', storage, now: () => 1_000_000 }))

    const before = build()
    await before.put('r1', { id: 'r1' })
    await createPendingConsent<Row>({ flow: before, notFound: 'x', reportDenied: () => {} }).deny('r1')

    expect(await build().peek('r1')).toBeNull()
  })
})
