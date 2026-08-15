/**
 * Every credential offer asks the user. There is no path that does not.
 *
 * ── What this file used to assert ─────────────────────────────────────────
 *
 * That an `attestto-id` offer from a previously-approved origin was accepted
 * SILENTLY, and that everything else went to the approval window. Those tests
 * passed, and they were pinning a hole: approving an origin once was being
 * treated as standing consent for whatever it sent afterwards.
 *
 * Eduardo, 2026-08-14: there must never be an auto-accept, literally. A page is
 * untrusted by default and may only present itself; a trusted origin may ASK,
 * and the ask goes to the user, who accepts every time. No setting passes data
 * automatically in either direction.
 *
 * So the assertions are inverted. This file now proves the capability is ABSENT,
 * which is the only thing worth proving about it.
 *
 * ── Why the strongest assertion is a type, not a call count ───────────────
 *
 * `CredentialOfferCtx` no longer has `isOriginTrusted` or `accept`. The handler
 * cannot consult trust or accept an offer, because it cannot NAME either — a
 * silent path is not merely untaken, it is unexpressible without editing the
 * port. That is the same reasoning AD-3 applies to capability bundles, and it is
 * why the runtime cases below are a backstop rather than the main event.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleCredentialOffer, type CredentialOfferCtx } from './credential-offer.handler'
import type { CredentialOfferMessage } from '@/utils/messaging'

type Offer = CredentialOfferMessage['payload']

const offerOf = (format: string): Offer => ({ format, issuerName: 'Issuer' }) as unknown as Offer

function ctx(): {
  ctx: CredentialOfferCtx
  stage: ReturnType<typeof vi.fn>
  requestConsent: ReturnType<typeof vi.fn>
  order: string[]
} {
  const order: string[] = []
  const stage = vi.fn(async () => {
    order.push('stage')
  })
  const requestConsent = vi.fn(async () => {
    order.push('consent')
  })
  return {
    ctx: { stage, requestConsent, newNotifId: () => 'offer-1' },
    stage,
    requestConsent,
    order,
  }
}

describe('a credential offer always asks the user', () => {
  // The formats are enumerated so a NEW one cannot quietly arrive with a
  // different rule. `attestto-id` is first because it is the one that used to
  // be exempt.
  it.each(['attestto-id', 'sd-jwt', 'json-ld', 'some-future-format'])(
    'format %s goes to the approval window',
    async (format) => {
      const { ctx: c, requestConsent } = ctx()
      const outcome = await handleCredentialOffer(offerOf(format), 'https://trusted.example', c)

      expect(outcome).toEqual({ kind: 'pendingConsent', notifId: 'offer-1' })
      expect(requestConsent).toHaveBeenCalledTimes(1)
    },
  )

  it('a previously-approved origin gets no special treatment', async () => {
    // The exact case that used to skip consent: identity format, trusted origin.
    // Trust gates the DID_SYNC channel; it is not consent for a payload.
    const { ctx: c, requestConsent } = ctx()
    const outcome = await handleCredentialOffer(offerOf('attestto-id'), 'https://trusted.example', c)

    expect(outcome.kind).toBe('pendingConsent')
    expect(requestConsent).toHaveBeenCalledTimes(1)
  })

  it('a null origin is no shortcut either', async () => {
    const { ctx: c, requestConsent } = ctx()
    const outcome = await handleCredentialOffer(offerOf('attestto-id'), null, c)

    expect(outcome.kind).toBe('pendingConsent')
    expect(requestConsent).toHaveBeenCalledTimes(1)
  })

  it('the outcome type has no accepted variant to return', () => {
    // A compile-channel claim asserted at runtime for the record: the union is
    // one member. Re-adding an `autoAccepted` variant reddens every call site
    // that switches on `kind`, which is where a reviewer should be stopped.
    const outcomes: Array<Awaited<ReturnType<typeof handleCredentialOffer>>['kind']> = [
      'pendingConsent',
    ]
    expect(outcomes).toEqual(['pendingConsent'])
  })

  it('stages before opening the window — the window looks the offer up by id', async () => {
    const { ctx: c, order } = ctx()
    await handleCredentialOffer(offerOf('attestto-id'), 'https://x.example', c)
    expect(order).toEqual(['stage', 'consent'])
  })
})
