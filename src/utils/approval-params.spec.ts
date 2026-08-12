/**
 * Story 1.13 Phase 4 — the approval-window URL contract.
 *
 * The assertions here are ROUND-TRIPS: a builder writes the query string, the
 * resolver that `approval.html` actually runs reads it back, and the values that
 * come out are compared to the values that went in. Nothing restates a param
 * name, so renaming one on either side breaks the round trip rather than being
 * mirrored by a test that was updated in the same edit.
 */
import { describe, it, expect } from 'vitest'
import { approvalParams, resolveApprovalMode, APPROVAL_MODE_PARAM } from './approval-params'

const qs = (params: Record<string, string>): string => new URLSearchParams(params).toString()

describe('round-trip: builder → approval page resolver', () => {
  it('credential offer survives the trip with issuer and format', () => {
    const out = resolveApprovalMode(
      qs(approvalParams.credentialOffer({ id: 'off-1', format: 'sd-jwt', issuerName: 'Banco', origin: 'https://banco.fi.cr' })),
    )
    expect(out).toEqual({
      mode: 'credentialOffer',
      requestId: 'off-1',
      format: 'sd-jwt',
      issuerName: 'Banco',
      origin: 'https://banco.fi.cr',
    })
  })

  it('credential offer with a null origin lands as an empty origin, not the string "null"', () => {
    const out = resolveApprovalMode(
      qs(approvalParams.credentialOffer({ id: 'off-2', format: 'attestto-id', issuerName: 'X', origin: null })),
    )
    expect(out).toMatchObject({ mode: 'credentialOffer', origin: '' })
  })

  it('auth carries the site name through when the tab title was resolvable', () => {
    const out = resolveApprovalMode(qs(approvalParams.auth({ id: 'a-1', origin: 'https://muni.go.cr', siteName: 'Municipalidad' })))
    expect(out).toEqual({ mode: 'auth', requestId: 'a-1', origin: 'https://muni.go.cr', siteName: 'Municipalidad' })
  })

  it('auth omits the site name entirely when the tab was gone, and the page sees null', () => {
    const built = approvalParams.auth({ id: 'a-2', origin: 'https://muni.go.cr' })
    expect('siteName' in built).toBe(false)
    expect(resolveApprovalMode(qs(built))).toMatchObject({ mode: 'auth', siteName: null })
  })

  it('Attestto PDF carries file name and document hash', () => {
    const out = resolveApprovalMode(
      qs(approvalParams.attesttoPdf({ id: 'p-1', origin: 'https://x.cr', fileName: 'escritura.pdf', documentHash: 'sha256-abc' })),
    )
    expect(out).toEqual({
      mode: 'attesttoPdf',
      requestId: 'p-1',
      origin: 'https://x.cr',
      fileName: 'escritura.pdf',
      documentHash: 'sha256-abc',
    })
  })

  it('an unnamed PDF reaches the page as the default file name, not as blank', () => {
    expect(resolveApprovalMode(qs(approvalParams.attesttoPdf({ id: 'p-2' })))).toMatchObject({ fileName: 'document.pdf' })
  })

  it('document signing carries title and signer', () => {
    const out = resolveApprovalMode(
      qs(approvalParams.signing({ id: 's-1', origin: 'https://x.cr', documentTitle: 'Contrato', signerName: 'Titular' })),
    )
    expect(out).toEqual({
      mode: 'signing',
      requestId: 's-1',
      origin: 'https://x.cr',
      documentTitle: 'Contrato',
      signerName: 'Titular',
    })
  })

  it('payment carries the amount as a NUMBER on the page side', () => {
    const out = resolveApprovalMode(
      qs(approvalParams.payment({ id: 'pay-1', origin: 'https://shop.cr', amount: 42.5, currency: 'CRC', merchantName: 'Tienda' })),
    )
    expect(out).toEqual({
      mode: 'payment',
      requestId: 'pay-1',
      origin: 'https://shop.cr',
      amount: 42.5,
      currency: 'CRC',
      merchant: 'Tienda',
    })
    expect(typeof (out as { amount: number }).amount).toBe('number')
  })

  it('payment defaults to USDC when the site named no currency', () => {
    expect(resolveApprovalMode(qs(approvalParams.payment({ id: 'pay-2', amount: 1 })))).toMatchObject({ currency: 'USDC' })
  })

  it('CHAPI carries id and origin', () => {
    const out = resolveApprovalMode(qs(approvalParams.chapi({ id: 'c-1', origin: 'https://verifier.cr' })))
    expect(out).toEqual({ mode: 'chapi', requestId: 'c-1', origin: 'https://verifier.cr' })
  })

  it('values needing escaping survive — an origin with a port and a title with spaces and an ampersand', () => {
    const out = resolveApprovalMode(
      qs(approvalParams.signing({ id: 'id with space', origin: 'http://localhost:3000', documentTitle: 'A & B / C?d=1' })),
    )
    expect(out).toMatchObject({
      requestId: 'id with space',
      origin: 'http://localhost:3000',
      documentTitle: 'A & B / C?d=1',
    })
  })
})

describe('mode selection', () => {
  it('a query string with no mode key resolves to none, which the page renders as "No request ID"', () => {
    expect(resolveApprovalMode('origin=https://x.cr')).toEqual({ mode: 'none' })
    expect(resolveApprovalMode('')).toEqual({ mode: 'none' })
  })

  it('an empty mode value does not select that mode', () => {
    expect(resolveApprovalMode(`${APPROVAL_MODE_PARAM.signing}=`)).toEqual({ mode: 'none' })
  })

  it('every builder selects a DISTINCT mode — no two flows collide on one page state', () => {
    const modes = [
      approvalParams.credentialOffer({ id: '1', format: '', issuerName: '', origin: '' }),
      approvalParams.auth({ id: '1', origin: '' }),
      approvalParams.attesttoPdf({ id: '1' }),
      approvalParams.signing({ id: '1' }),
      approvalParams.payment({ id: '1', amount: 0 }),
      approvalParams.chapi({ id: '1' }),
    ].map((p) => resolveApprovalMode(qs(p)).mode)
    expect(new Set(modes).size).toBe(modes.length)
    expect(modes).not.toContain('none')
  })

  it('the priority order is credentialOffer › auth › attesttoPdf › signing › payment › chapi', () => {
    const order = ['credentialOffer', 'auth', 'attesttoPdf', 'signing', 'payment', 'chapi'] as const
    // Build a URL carrying EVERY mode key, then strip them from the front one at
    // a time: whatever remains highest in the chain must win each round.
    const all: Record<string, string> = {}
    for (const mode of order) all[APPROVAL_MODE_PARAM[mode]] = `id-${mode}`

    for (const expected of order) {
      const out = resolveApprovalMode(qs(all))
      expect(out.mode).toBe(expected)
      expect(out).toMatchObject({ requestId: `id-${expected}` })
      delete all[APPROVAL_MODE_PARAM[expected]]
    }
    expect(resolveApprovalMode(qs(all))).toEqual({ mode: 'none' })
  })
})
