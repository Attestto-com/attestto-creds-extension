/**
 * Story 1.13 Phase 3 — the response contract, pinned against an INDEPENDENT referent.
 *
 * A spec that restates the literals in `tab-responses.ts` ("expect type to be
 * 'AUTH_RESPONSE'") proves only that the file says what the file says. The thing
 * that actually decides whether a response reaches the caller is the page bridge
 * in `entrypoints/credential-api.content.ts`: it matches on the envelope `type`
 * and reads named `payload.*` fields. So this spec RUNS THE REAL BRIDGE and
 * asserts on what the page receives.
 *
 * That makes the test sensitive to the failures that matter and blind to the
 * ones that don't:
 *   - rename the envelope `type`      → the bridge never matches → page gets nothing → RED
 *   - rename/drop a payload field     → the bridge forwards `undefined`           → RED
 *   - reorder or reword a comment     → page-facing values unchanged              → green
 *
 * The expected values below come from the arguments passed IN, never from the
 * module under test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import contentScript from '@/entrypoints/credential-api.content'
import * as tx from './tab-responses'

type BridgeListener = (message: { type: string; payload: Record<string, unknown> }) => void

let sentToTab: unknown[]
let postedToPage: Record<string, unknown>[]
let bridge: BridgeListener

/** Install the chrome surface both the transport and the content script touch. */
function installChrome(): void {
  sentToTab = []
  const listeners: BridgeListener[] = []
  const chromeMock = {
    tabs: {
      sendMessage: vi.fn((_tabId: number, message: unknown) => {
        sentToTab.push(message)
        return Promise.resolve()
      }),
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: vi.fn(() => Promise.resolve()),
      onMessage: { addListener: (fn: BridgeListener) => listeners.push(fn) },
    },
  }
  ;(globalThis as Record<string, unknown>).chrome = chromeMock

  // Boot the REAL content script so its response bridge is the referent.
  ;(contentScript as unknown as { main: () => void }).main()
  bridge = (msg) => listeners.forEach((l) => l(msg))
}

/**
 * Drive one transport call all the way to the page:
 *   transport → chrome.tabs.sendMessage → real bridge → window.postMessage
 * Returns what the page would have received (or undefined if nothing arrived).
 */
function roundTrip(send: () => void): Record<string, unknown> | undefined {
  sentToTab = []
  postedToPage = []
  send()
  for (const message of sentToTab) {
    bridge(message as { type: string; payload: Record<string, unknown> })
  }
  return postedToPage[0]
}

beforeEach(() => {
  installChrome()
  postedToPage = []
  vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
    postedToPage.push(data as Record<string, unknown>)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const TAB = 7
const REQ = 'req-abc'

describe('tab-responses → page bridge round-trip', () => {
  it('document signing success reaches the page as ATTESTTO_SIGN_RESPONSE with every field', () => {
    const page = roundTrip(() =>
      tx.sendSigningResponseToTab(TAB, REQ, {
        did: 'did:jwk:zSign',
        signature: 'sig-doc',
        publicKeyJwk: { kty: 'EC', crv: 'P-256' },
        timestamp: '2026-08-08T00:00:00Z',
      }),
    )
    expect(page).toMatchObject({
      type: 'ATTESTTO_SIGN_RESPONSE',
      requestId: REQ,
      did: 'did:jwk:zSign',
      signature: 'sig-doc',
      publicKeyJwk: { kty: 'EC', crv: 'P-256' },
      timestamp: '2026-08-08T00:00:00Z',
    })
  })

  it('document signing error reaches the page on the same channel', () => {
    const page = roundTrip(() => tx.sendSigningErrorToTab(TAB, REQ, 'user_denied'))
    expect(page).toMatchObject({ type: 'ATTESTTO_SIGN_RESPONSE', requestId: REQ, error: 'user_denied' })
  })

  it('auth success carries did, signature, nonce, timestamp and key to the page', () => {
    const page = roundTrip(() =>
      tx.sendAuthResponseToTab(TAB, REQ, {
        did: 'did:jwk:zAuth',
        signature: 'sig-auth',
        nonce: 'nonce-1',
        timestamp: '2026-08-08T00:01:00Z',
        publicKeyJwk: { kty: 'EC', x: 'xx' },
      }),
    )
    expect(page).toMatchObject({
      type: 'ATTESTTO_AUTH_RESPONSE',
      requestId: REQ,
      did: 'did:jwk:zAuth',
      signature: 'sig-auth',
      nonce: 'nonce-1',
      timestamp: '2026-08-08T00:01:00Z',
      publicKeyJwk: { kty: 'EC', x: 'xx' },
    })
  })

  it('auth error reaches the page', () => {
    const page = roundTrip(() => tx.sendAuthErrorToTab(TAB, REQ, 'locked'))
    expect(page).toMatchObject({ type: 'ATTESTTO_AUTH_RESPONSE', requestId: REQ, error: 'locked' })
  })

  it('credential-wallet auth forwards the whole AuthResponse object (SOC-71)', () => {
    const response = { did: 'did:jwk:zCw', proof: { jws: 'abc' } } as never
    const page = roundTrip(() => tx.sendCwAuthResponseToTab(TAB, REQ, response))
    expect(page).toMatchObject({
      type: 'ATTESTTO_CW_AUTH_RESPONSE',
      requestId: REQ,
      response: { did: 'did:jwk:zCw', proof: { jws: 'abc' } },
    })
  })

  it('credential-wallet auth error reaches the page', () => {
    const page = roundTrip(() => tx.sendCwAuthErrorToTab(TAB, REQ, 'no_identity'))
    expect(page).toMatchObject({ type: 'ATTESTTO_CW_AUTH_RESPONSE', requestId: REQ, error: 'no_identity' })
  })

  it('Attestto PDF signing carries the raw publicKey (not a JWK) to the page', () => {
    const page = roundTrip(() =>
      tx.sendAttesttoPdfResponseToTab(TAB, REQ, {
        did: 'did:jwk:zPdf',
        signature: 'sig-pdf',
        publicKey: 'z6Mkbase58',
      }),
    )
    expect(page).toMatchObject({
      type: 'ATTESTTO_SIGN_PDF_RESPONSE',
      requestId: REQ,
      did: 'did:jwk:zPdf',
      signature: 'sig-pdf',
      publicKey: 'z6Mkbase58',
    })
  })

  it('Attestto PDF error reaches the page', () => {
    const page = roundTrip(() => tx.sendAttesttoPdfErrorToTab(TAB, REQ, 'provisioning_failed'))
    expect(page).toMatchObject({ type: 'ATTESTTO_SIGN_PDF_RESPONSE', requestId: REQ, error: 'provisioning_failed' })
  })

  it('payment success reaches the page', () => {
    const page = roundTrip(() =>
      tx.sendPaymentResponseToTab(TAB, REQ, {
        did: 'did:jwk:zPay',
        signature: 'sig-pay',
        publicKeyJwk: { kty: 'EC', y: 'yy' },
      }),
    )
    expect(page).toMatchObject({
      type: 'ATTESTTO_PAYMENT_RESPONSE',
      requestId: REQ,
      did: 'did:jwk:zPay',
      signature: 'sig-pay',
      publicKeyJwk: { kty: 'EC', y: 'yy' },
    })
  })

  it('payment error reaches the page', () => {
    const page = roundTrip(() => tx.sendPaymentErrorToTab(TAB, REQ, 'insufficient_funds'))
    expect(page).toMatchObject({ type: 'ATTESTTO_PAYMENT_RESPONSE', requestId: REQ, error: 'insufficient_funds' })
  })

  it('CHAPI error reaches the page as a VP response', () => {
    const page = roundTrip(() => tx.sendChapiErrorToTab(TAB, REQ, 'no_matching_credential'))
    expect(page).toMatchObject({ type: 'ATTESTTO_VP_RESPONSE', requestId: REQ, error: 'no_matching_credential' })
  })

  it('DID sync carries publicKeyJwk and holderDid to the page', () => {
    const page = roundTrip(() =>
      tx.sendDidSyncResponse(TAB, REQ, { kty: 'EC', crv: 'P-256' }, 'did:sns:holder.attestto.sol', null),
    )
    expect(page).toMatchObject({
      type: 'ATTESTTO_DID_SYNC_RESPONSE',
      requestId: REQ,
      publicKeyJwk: { kty: 'EC', crv: 'P-256' },
      holderDid: 'did:sns:holder.attestto.sol',
      error: null,
    })
  })

  it('DID sync failure carries the error with null key material', () => {
    const page = roundTrip(() => tx.sendDidSyncResponse(TAB, REQ, null, null, 'untrusted_origin'))
    expect(page).toMatchObject({
      type: 'ATTESTTO_DID_SYNC_RESPONSE',
      requestId: REQ,
      publicKeyJwk: null,
      holderDid: null,
      error: 'untrusted_origin',
    })
  })

  it('re-share error reaches the page as a re-share VP response', () => {
    const page = roundTrip(() => tx.sendReshareError(TAB, REQ, 'credential_missing'))
    expect(page).toMatchObject({ type: 'ATTESTTO_RESHARE_VP_RESPONSE', requestId: REQ, error: 'credential_missing' })
  })
})

describe('no originating tab', () => {
  const nullTabCalls: [string, () => void][] = [
    ['sendSigningErrorToTab', () => tx.sendSigningErrorToTab(null, REQ, 'e')],
    ['sendSigningResponseToTab', () => tx.sendSigningResponseToTab(null, REQ, { did: 'd', signature: 's', publicKeyJwk: {}, timestamp: 't' })],
    ['sendAuthErrorToTab', () => tx.sendAuthErrorToTab(null, REQ, 'e')],
    ['sendAuthResponseToTab', () => tx.sendAuthResponseToTab(null, REQ, { did: 'd', signature: 's', nonce: 'n', timestamp: 't', publicKeyJwk: {} })],
    ['sendCwAuthErrorToTab', () => tx.sendCwAuthErrorToTab(null, REQ, 'e')],
    ['sendCwAuthResponseToTab', () => tx.sendCwAuthResponseToTab(null, REQ, {} as never)],
    ['sendAttesttoPdfErrorToTab', () => tx.sendAttesttoPdfErrorToTab(null, REQ, 'e')],
    ['sendAttesttoPdfResponseToTab', () => tx.sendAttesttoPdfResponseToTab(null, REQ, { did: 'd', signature: 's', publicKey: 'p' })],
    ['sendPaymentErrorToTab', () => tx.sendPaymentErrorToTab(null, REQ, 'e')],
    ['sendPaymentResponseToTab', () => tx.sendPaymentResponseToTab(null, REQ, { did: 'd', signature: 's', publicKeyJwk: {} })],
    ['sendChapiErrorToTab', () => tx.sendChapiErrorToTab(null, REQ, 'e')],
    ['sendDidSyncResponse', () => tx.sendDidSyncResponse(null, REQ, null, null, 'e')],
    ['sendReshareError', () => tx.sendReshareError(null, REQ, 'e')],
  ]

  it.each(nullTabCalls)('%s attempts no delivery when there is no tab', (_name, send) => {
    sentToTab = []
    send()
    expect(sentToTab).toEqual([])
  })

  it('warns for the flows whose caller is blocked waiting on a reply', () => {
    const warn = vi.mocked(console.warn)
    warn.mockClear()
    tx.sendChapiErrorToTab(null, REQ, 'e')
    tx.sendDidSyncResponse(null, REQ, null, null, 'e')
    tx.sendReshareError(null, REQ, 'e')
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

/**
 * The `key administration transport` describe that lived here is gone (SOC-144).
 *
 * It asserted the shape of three senders that could never deliver: only an
 * extension page may invoke rotate/backup/restore, and an extension page has no
 * `sender.tab`, so every real call was dropped. The tests passed by calling them
 * with a synthetic tab id no caller could produce — green for a transport that
 * had never carried anything.
 *
 * The three cases now answer over `sendResponse`; their reachability is proven
 * in `__tests__/entrypoints/key-admin-transport.spec.ts`, through the real
 * dispatch, with an extension-page sender shape.
 */
