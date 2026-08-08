/**
 * Story 1.13 Phase 7 — the pending-consent registry.
 *
 * Two properties carry the security weight, and both are about ORDER and COUNT
 * rather than about any single call happening:
 *
 *   - deny disarms the approval window BEFORE purging, so a window closing right
 *     after a deny cannot report a second cancellation.
 *   - deny is idempotent: whatever the page is told, it is told once.
 *
 * So the assertions are on an observed event LOG — every effect in the order it
 * happened — not on "was this collaborator called". A spy that only records
 * `toHaveBeenCalled` passes for an implementation that reports twice.
 */
import { describe, it, expect } from 'vitest'
import { createPendingConsent, type ConsentRow } from './pending-consent'

interface Row extends ConsentRow {
  id: string
  secret?: string
}

/** A registry whose every effect lands in one ordered log. */
function registry(rows: [string, Row][] = [['r1', { id: 'r1' }]]) {
  const log: string[] = []
  const map = new Map<string, Row>(
    rows.map(([k, v]) => [k, { ...v, unregister: () => log.push(`unregister:${k}`) }]),
  )
  const consent = createPendingConsent<Row>({
    rows: map,
    notFound: 'No pending request found',
    reportDenied: (row) => log.push(`reported:${row.id}`),
  })
  return { consent, map, log }
}

describe('peek', () => {
  it('returns the row for a live request', () => {
    const { consent } = registry()
    expect(consent.peek('r1')).toEqual({ ok: true, request: expect.objectContaining({ id: 'r1' }) })
  })

  it('reports not-found for an unknown id, with the flow-specific message', () => {
    const { consent } = registry()
    expect(consent.peek('nope')).toEqual({ ok: false, error: 'No pending request found' })
  })

  it('reports not-found rather than throwing when the message carried no id', () => {
    const { consent } = registry()
    expect(consent.peek(undefined)).toEqual({ ok: false, error: 'No pending request found' })
    expect(consent.peek('')).toEqual({ ok: false, error: 'No pending request found' })
  })

  it('does not consume the row — a peek is not a take', () => {
    const { consent, map } = registry()
    consent.peek('r1')
    consent.peek('r1')
    expect(map.has('r1')).toBe(true)
  })

  it('never returns another flow\'s row', () => {
    const { consent } = registry([
      ['r1', { id: 'r1' }],
      ['r2', { id: 'r2', secret: 'other-flow' }],
    ])
    const out = consent.peek('r1')
    expect(out).toMatchObject({ ok: true })
    expect(JSON.stringify(out)).not.toContain('other-flow')
  })
})

describe('deny', () => {
  it('disarms the approval window BEFORE reporting, so a late window-close is a no-op', () => {
    const { consent, log } = registry()
    consent.deny('r1')
    expect(log).toEqual(['unregister:r1', 'reported:r1'])
  })

  it('purges the row', () => {
    const { consent, map } = registry()
    consent.deny('r1')
    expect(map.has('r1')).toBe(false)
  })

  it('reports EXACTLY ONCE when denied twice', () => {
    const { consent, log } = registry()
    consent.deny('r1')
    consent.deny('r1')
    expect(log.filter((e) => e.startsWith('reported'))).toEqual(['reported:r1'])
  })

  it('reports nothing for a row that was already approved and removed', () => {
    const { consent, map, log } = registry()
    map.delete('r1') // the APPROVE path consumed it
    consent.deny('r1')
    expect(log).toEqual([])
  })

  it('reports nothing for an unknown id or a missing one', () => {
    const { consent, log } = registry()
    consent.deny('nope')
    consent.deny(undefined)
    consent.deny('')
    expect(log).toEqual([])
    expect(consent.peek('r1')).toMatchObject({ ok: true })
  })

  it('denies only the named row, leaving concurrent approvals alone', () => {
    const { consent, map, log } = registry([
      ['r1', { id: 'r1' }],
      ['r2', { id: 'r2' }],
    ])
    consent.deny('r1')
    expect(map.has('r2')).toBe(true)
    expect(log).toEqual(['unregister:r1', 'reported:r1'])
  })

  it('still purges and reports for a row that never armed a window', () => {
    const map = new Map<string, Row>([['r1', { id: 'r1' }]]) // no unregister hook
    const log: string[] = []
    const consent = createPendingConsent<Row>({
      rows: map,
      notFound: 'x',
      reportDenied: (row) => log.push(`reported:${row.id}`),
    })
    consent.deny('r1')
    expect(map.has('r1')).toBe(false)
    expect(log).toEqual(['reported:r1'])
  })

  it('hands the reporter the row itself, so a flow can route by its own fields', () => {
    // The auth flow needs this: a `cw` request must be answered on the
    // CW_AUTH_RESPONSE channel, not the legacy AUTH_RESPONSE one.
    const seen: Row[] = []
    const consent = createPendingConsent<Row>({
      rows: new Map([['r1', { id: 'r1', secret: 'cw' }]]),
      notFound: 'x',
      reportDenied: (row) => seen.push(row),
    })
    consent.deny('r1')
    expect(seen).toEqual([{ id: 'r1', secret: 'cw' }])
  })
})
