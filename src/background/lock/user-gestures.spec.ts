/**
 * Story 1.14 — the user-gesture allowlist.
 *
 * The interesting assertion is the NEGATIVE one, and it is written against the
 * full `MESSAGE_TYPES` tuple rather than a hand-copied list: every message that
 * a web page can cause must be absent. Enumerating the complement this way means
 * a message added to the router in a later story is denied by default and shows
 * up here the moment someone tries to make it count as activity.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MESSAGE_TYPES, type MessageType } from '@/background/router/message-types'
import { USER_GESTURE_MESSAGES, isUserGesture, shouldCountAsActivity } from './user-gestures'

/** Everything a page or the network can trigger without anybody clicking. */
const PAGE_TRIGGERABLE: readonly MessageType[] = [
  'CREDENTIAL_OFFER',
  'WALLET_LINK',
  'PROOF_ACCESS_REQUEST',
  'PUSH_PRESENTATION',
  'DIDCOMM_INBOUND',
  'CREDENTIAL_API_REQUEST',
  'LIST_STORED_CREDENTIALS',
  'RESHARE_STORED_VP',
  'DID_SYNC',
  'SIGN_DOCUMENT_REQUEST',
  'AUTH_REQUEST',
  'CW_AUTH_REQUEST',
  'SIGN_ATTESTTO_PDF_REQUEST',
  'PAYMENT_REQUEST',
  'CERT_SCAN_REQUEST',
  'SUBMIT_THREAT_REPORT',
]

describe('what counts as user activity', () => {
  it('no page-triggerable message extends the lock — the whole defect', () => {
    const leaking = PAGE_TRIGGERABLE.filter((t) => isUserGesture(t))
    expect(leaking).toEqual([])
  })

  it('a window opening to ASK for approval is not itself approval', () => {
    // `*_GET_PENDING` is the approval page loading. The window was opened by a
    // page request; if its load counted, a site could re-arm the timer by
    // requesting a signature the user never answers.
    const getPending = MESSAGE_TYPES.filter((t) => t.endsWith('_GET_PENDING'))
    expect(getPending.length).toBeGreaterThan(0)
    expect(getPending.filter((t) => isUserGesture(t))).toEqual([])
  })

  it('every approve and deny counts — those cannot happen without a click', () => {
    const decisions = MESSAGE_TYPES.filter((t) => t.endsWith('_APPROVE') || t.endsWith('_DENY'))
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions.filter((t) => !isUserGesture(t))).toEqual([])
  })

  it('the popup can report its own interaction', () => {
    expect(isUserGesture('WALLET_ACTIVITY')).toBe(true)
  })

  it('SESSION_EXPIRED is a lock, not activity', () => {
    expect(isUserGesture('SESSION_EXPIRED')).toBe(false)
  })

  it('every member is a real dispatched message type', () => {
    const unknown = [...USER_GESTURE_MESSAGES].filter((t) => !MESSAGE_TYPES.includes(t))
    expect(unknown).toEqual([])
  })

  it('rejects non-strings and near-misses rather than throwing', () => {
    expect(isUserGesture(undefined)).toBe(false)
    expect(isUserGesture({ type: 'AUTH_APPROVE' })).toBe(false)
    expect(isUserGesture('auth_approve')).toBe(false)
  })
})

describe('shouldCountAsActivity — the decision the worker actually makes', () => {
  const EXT = 'chrome-extension://abcdefghijklmnop'
  const fromPopup = { url: `${EXT}/popup.html` }
  const fromApproval = { url: `${EXT}/approval.html?mode=auth` }
  /** A content script: Chrome always sets `tab` on these. */
  const fromPage = { tab: { id: 7 }, url: 'https://evil.example/x', origin: 'https://evil.example' }

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).chrome = {
      runtime: { getURL: (p: string) => `${EXT}/${p.replace(/^\//, '')}` },
    }
  })

  it('a page CANNOT forge a gesture — the sender check, not the type check', () => {
    // `credential-api.content.ts` runs on https://*/*. Without this half, one
    // `postMessage` from any tab would hold the vault open indefinitely.
    expect(shouldCountAsActivity(fromPage as never, { type: 'AUTH_APPROVE' })).toBe(false)
    expect(shouldCountAsActivity(fromPage as never, { type: 'WALLET_ACTIVITY' })).toBe(false)
  })

  it('the approval window CAN — that is a user pressing a button', () => {
    expect(shouldCountAsActivity(fromApproval as never, { type: 'AUTH_APPROVE' })).toBe(true)
  })

  it('the popup CAN report its own interaction', () => {
    expect(shouldCountAsActivity(fromPopup as never, { type: 'WALLET_ACTIVITY' })).toBe(true)
  })

  it('an extension sender still cannot pass off a non-gesture', () => {
    expect(shouldCountAsActivity(fromPopup as never, { type: 'CREDENTIAL_OFFER' })).toBe(false)
    expect(shouldCountAsActivity(fromPopup as never, { type: 'AUTH_GET_PENDING' })).toBe(false)
  })

  it('an extension-looking URL on some other origin does not pass', () => {
    const impostor = { url: 'chrome-extension://zzzzzzzzzzzzzzzz/popup.html' }
    expect(shouldCountAsActivity(impostor as never, { type: 'WALLET_ACTIVITY' })).toBe(false)
  })

  it('survives a malformed message rather than throwing at the listener', () => {
    expect(shouldCountAsActivity(fromPopup as never, null)).toBe(false)
    expect(shouldCountAsActivity(fromPopup as never, undefined)).toBe(false)
    expect(shouldCountAsActivity(fromPopup as never, 'AUTH_APPROVE')).toBe(false)
    expect(shouldCountAsActivity(undefined, { type: 'AUTH_APPROVE' })).toBe(false)
  })
})

/**
 * The predicate above is only worth anything if the worker calls it. This is the
 * lesson from Story 1.13's SOC-144: a handler with green tests and no caller is
 * dead code that looks covered. `background.ts` lives inside `defineBackground()`
 * and cannot be booted here (WXT would treat a spec under `entrypoints/` as an
 * entrypoint), so the CALL SITE is asserted against the source.
 */
describe('the worker is wired to it', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/entrypoints/background.ts'), 'utf8')

  it('the message listener consults the predicate and touches the lock', () => {
    expect(source).toMatch(/if \(shouldCountAsActivity\(sender, message\)\) \{\s*idleLock\.touch\(\)/)
  })

  it('the worker re-arms on start and never touches there', () => {
    expect(source).toContain('idleLock.resume()')
    // `touch()` at the top level is the old defect: every worker wake would
    // extend the deadline. It must appear ONLY in the gesture branch.
    expect(source.match(/idleLock\.touch\(\)/g)).toHaveLength(1)
  })

  it('the alarm listener hands every alarm to the lock', () => {
    expect(source).toContain('idleLock.onAlarm(alarm.name)')
  })

  it('nothing else in the worker clears the session key behind the lock', () => {
    // One legitimate site remains: the explicit `SESSION_EXPIRED` message.
    const removals = source.match(/storage\.session\.remove\(/g) ?? []
    expect(removals).toHaveLength(1)
  })
})
