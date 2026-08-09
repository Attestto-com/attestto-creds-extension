/**
 * Story 1.9 — CHARACTERIZATION of the DIDCOMM_INBOUND handler (parity-to-legacy).
 *
 * These goldens are transcribed from the OLD switch case (background.ts:1540)
 * BEFORE the handler existed: parse → (if parsed) create the exact notification +
 * forward the exact message → always respond ok; null parse → zero effects. The
 * extracted handler must satisfy them UNCHANGED — parity is the AC (inversion ii),
 * not "the handler works". A near-verbatim move + an independently-transcribed
 * golden means a transcription slip on either side reddens.
 *
 * The referent for every case is an EFFECT SPY (which port fired, with what args,
 * in what order) — never the return value alone.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleDidcommInbound } from './didcomm-inbound.handler'
import { parseProofRequest } from '@/services/didcomm'
import { dispatch } from '@/background/router/dispatch'
import { MESSAGE_ROUTES } from '@/background/router/routes'

// A well-formed inbound proof request (parseProofRequest returns non-null).
const VALID_INBOUND = {
  id: 'req-77',
  type: 'https://didcomm.org/present-proof/3.0/request-presentation',
  from: 'did:sns:verifier.attestto',
  body: {
    comment: 'KYC check',
    request_presentations_attach: [
      { id: 'a0', data: { nonce: 'n77', requestedFields: ['fullName'], audience: 'aud' } },
    ],
  },
}

function spyCtx() {
  const order: string[] = []
  const create = vi.fn(async () => { order.push('create') })
  const sendMessage = vi.fn(async () => { order.push('send') })
  const getURL = vi.fn((p: string) => `chrome-extension://fake/${p}`)
  const ctx = {
    notify: { show: vi.fn(async () => {}) },
    http: { fetch: vi.fn(async () => ({})) },
    notifications: { create },
    runtime: { sendMessage, getURL },
  }
  return { ctx: ctx as unknown as Parameters<typeof handleDidcommInbound>[1], create, sendMessage, getURL, order }
}

describe('handleDidcommInbound — parsed inbound (parity)', () => {
  it('creates the notification AND forwards the parsed request, in that order, then responds ok', async () => {
    const { ctx, create, sendMessage, getURL, order } = spyCtx()
    const parsed = parseProofRequest(VALID_INBOUND) // the exact object the legacy forwards

    const res = await handleDidcommInbound(VALID_INBOUND, ctx)

    // notification: exact id + options (golden from legacy source)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('didcomm-req-77', {
      type: 'basic',
      iconUrl: 'chrome-extension://fake/icon/48.png',
      title: 'DIDComm Proof Request',
      message: 'did:sns:verifier.attestto is requesting identity verification via DIDComm v2.',
      buttons: [{ title: 'Review' }, { title: 'Dismiss' }],
      requireInteraction: true,
    })
    expect(getURL).toHaveBeenCalledWith('icon/48.png')

    // forward: exact shape, carrying the parsed request
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith({ type: 'DIDCOMM_PROOF_REQUEST', payload: parsed })

    // order: notify BEFORE forward (the popup must not receive a forward for a
    // notification that doesn't exist yet — an ordering the monolith guaranteed)
    expect(order).toEqual(['create', 'send'])

    // always ok
    expect(res).toEqual({ ok: true })
  })
})

describe('handleDidcommInbound — null parse (the dropped edge)', () => {
  it('does NOTHING (no notification, no forward) but still responds ok', async () => {
    const { ctx, create, sendMessage } = spyCtx()
    const res = await handleDidcommInbound({ not: 'a proof request' }, ctx)
    expect(create).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true })
  })
})

describe('DIDCOMM_INBOUND parity: WHY the case delegates to handle() directly', () => {
  it('routing through the full dispatch pipeline would REJECT (empty allowFrom) — a regression', async () => {
    // The legacy case does no sender-auth. dispatch runs the route's allowFrom,
    // still the fail-closed empty stub, so it rejects every inbound. That is why
    // the switch case must call route.handle(payload, ctx) directly until Epic 2
    // fills real allowFrom + the verifyPeer 'envelope' check. If a future edit
    // wires this route through dispatch prematurely, this expectation flips and
    // forces a conscious decision.
    const res = await dispatch(
      { type: 'DIDCOMM_INBOUND', payload: VALID_INBOUND },
      {},
      { buildBundle: (() => ({})) as never, resolveSender: () => ({ origin: 'https://verifier.example', kind: 'web' }) },
    )
    expect(res).toEqual({ ok: false, error: 'forbidden-origin' })
  })

  /**
   * Story 2.2 — was `{ check: 'envelope' }`, asserted here and executed nowhere:
   * `dispatch` ran `verifyPeer` only when it was a FUNCTION, so this assertion
   * passed while the check was inert. Renamed to `senderResolvable` because that
   * is all it establishes — the claimed sender DID resolves under an allowed
   * method. It is NOT authentication: the envelope parsed by this handler
   * carries no signature. Execution is proven in `dispatch.spec.ts`, not here;
   * this only pins the declaration.
   */
  it('the route declares the AD-9 senderResolvable check', () => {
    expect(MESSAGE_ROUTES.DIDCOMM_INBOUND.verifyPeer).toEqual({ check: 'senderResolvable' })
  })
})
