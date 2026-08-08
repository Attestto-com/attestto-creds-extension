/**
 * Story 1.13 Phase 9 — the credential-offer intake gate.
 *
 * "Silent" is the failure mode: an offer accepted without consent leaves no
 * trace a user would notice. So the assertions are on an ordered EFFECT LOG,
 * and the decisive ones are exhaustive rather than illustrative — every
 * combination of {format, origin trust} is enumerated, because the hole this
 * gate closes was one specific cell of that table being wrong.
 */
import { describe, it, expect } from 'vitest'
import { handleCredentialOffer, type CredentialOfferCtx } from './credential-offer.handler'
import type { CredentialOfferMessage } from '@/utils/messaging'

type Offer = CredentialOfferMessage['payload']

const NOTIF = 'credential-offer-fixed'

const offerOf = (format: string): Offer =>
  ({ format, issuerName: 'Issuer', raw: '{}' }) as unknown as Offer

function harness(opts: { trusted?: boolean; acceptResult?: string | null } = {}) {
  const log: string[] = []
  const ctx: CredentialOfferCtx = {
    isOriginTrusted: async (origin) => {
      log.push(`checked-trust:${origin}`)
      return opts.trusted ?? false
    },
    stage: (notifId, offer, origin) => {
      log.push(`staged:${notifId}:${offer.format}:${origin}`)
    },
    accept: async (notifId) => {
      log.push(`accepted:${notifId}`)
      return opts.acceptResult === undefined ? 'cred-1' : opts.acceptResult
    },
    requestConsent: async (notifId) => {
      log.push(`asked-user:${notifId}`)
    },
    newNotifId: () => NOTIF,
  }
  return { ctx, log }
}

/** Every combination of format and origin trust. Exactly one cell may be silent. */
const MATRIX: { format: string; trusted: boolean; silent: boolean }[] = [
  { format: 'attestto-id', trusted: true, silent: true },
  { format: 'attestto-id', trusted: false, silent: false },
  { format: 'sd-jwt', trusted: true, silent: false },
  { format: 'sd-jwt', trusted: false, silent: false },
  { format: 'json-ld', trusted: true, silent: false },
  { format: 'json-ld', trusted: false, silent: false },
  { format: 'unknown-future-format', trusted: true, silent: false },
  { format: 'unknown-future-format', trusted: false, silent: false },
]

describe('the silent-acceptance matrix', () => {
  it.each(MATRIX)(
    'format=$format trusted=$trusted → silent=$silent',
    async ({ format, trusted, silent }) => {
      const { ctx, log } = harness({ trusted })
      const outcome = await handleCredentialOffer(offerOf(format), 'https://site.cr', ctx)

      expect(outcome.kind).toBe(silent ? 'autoAccepted' : 'pendingConsent')
      expect(log).toContain(silent ? `accepted:${NOTIF}` : `asked-user:${NOTIF}`)
      expect(log).not.toContain(silent ? `asked-user:${NOTIF}` : `accepted:${NOTIF}`)
    },
  )

  it('exactly ONE of the eight combinations accepts without asking', () => {
    expect(MATRIX.filter((m) => m.silent)).toEqual([
      { format: 'attestto-id', trusted: true, silent: true },
    ])
  })
})

describe('trust is only consulted where it can matter', () => {
  it('a non-identity offer is not even trust-checked — trust cannot make it silent', async () => {
    const { ctx, log } = harness({ trusted: true })
    await handleCredentialOffer(offerOf('sd-jwt'), 'https://trusted.cr', ctx)
    expect(log.some((e) => e.startsWith('checked-trust'))).toBe(false)
  })

  it('an identity offer is checked against the origin it actually arrived from', async () => {
    const { ctx, log } = harness({ trusted: false })
    await handleCredentialOffer(offerOf('attestto-id'), 'https://app.attestto.com', ctx)
    expect(log).toContain('checked-trust:https://app.attestto.com')
  })

  it('a null origin cannot be silently trusted', async () => {
    // A null origin reaching `isOriginTrusted` normalizes to no key and returns
    // false there; this pins that the gate still routes to consent.
    const { ctx } = harness({ trusted: false })
    const outcome = await handleCredentialOffer(offerOf('attestto-id'), null, ctx)
    expect(outcome.kind).toBe('pendingConsent')
  })
})

describe('staging order', () => {
  it('stages the pending row BEFORE accepting, or accept would find nothing', async () => {
    const { ctx, log } = harness({ trusted: true })
    await handleCredentialOffer(offerOf('attestto-id'), 'https://x.cr', ctx)
    expect(log.indexOf(`staged:${NOTIF}:attestto-id:https://x.cr`)).toBeLessThan(
      log.indexOf(`accepted:${NOTIF}`),
    )
  })

  it('stages the pending row BEFORE opening the approval window', async () => {
    const { ctx, log } = harness({ trusted: false })
    await handleCredentialOffer(offerOf('sd-jwt'), 'https://x.cr', ctx)
    expect(log[0]).toBe(`staged:${NOTIF}:sd-jwt:https://x.cr`)
    expect(log).toContain(`asked-user:${NOTIF}`)
  })

  it('stages under the id both branches then use', async () => {
    const { ctx, log } = harness({ trusted: true })
    const outcome = await handleCredentialOffer(offerOf('attestto-id'), 'https://x.cr', ctx)
    expect(outcome).toEqual({ kind: 'autoAccepted', credentialId: 'cred-1' })
    expect(log.filter((e) => e.includes(NOTIF)).length).toBe(2)
  })
})

describe('outcome reporting', () => {
  it('reports a failed auto-accept as accepted-with-null rather than as consent-pending', async () => {
    // The page must not be told consent is pending when no window was opened —
    // it would wait for an approval that is never coming.
    const { ctx, log } = harness({ trusted: true, acceptResult: null })
    const outcome = await handleCredentialOffer(offerOf('attestto-id'), 'https://x.cr', ctx)
    expect(outcome).toEqual({ kind: 'autoAccepted', credentialId: null })
    expect(log).not.toContain(`asked-user:${NOTIF}`)
  })

  it('returns the notifId with a pending-consent outcome so the caller can correlate', async () => {
    const { ctx } = harness({ trusted: false })
    const outcome = await handleCredentialOffer(offerOf('sd-jwt'), 'https://x.cr', ctx)
    expect(outcome).toEqual({ kind: 'pendingConsent', notifId: NOTIF })
  })
})
