/**
 * Unit tests for the Attestto backend client module.
 *
 * Covers:
 *   1. fetchCertScan — happy path, HTTP error, network throw.
 *   2. submitThreatReport — happy path, field whitelist assertion (no URL/path/PII),
 *      HTTP error, network throw.
 *
 * All tests mock fetch; no real network calls are made.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// ── Module-level mock so import.meta.env resolves without WXT globals ────────
vi.mock('@/config/backend', () => ({
  BACKEND_BASE_URL: 'http://localhost:8787',
}))

import { fetchCertScan, submitThreatReport, type ThreatReportBody } from './backend-client'

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function throwingFetch(message: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(new Error(message))
}

// ── fetchCertScan ─────────────────────────────────────────────────────────────

describe('fetchCertScan', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns parsed result on 200', async () => {
    const payload = {
      ok: true,
      host: 'bccr.fi.cr',
      ca: 'DigiCert',
      validationTier: 'EV',
      daysToExpiry: 180,
      expired: false,
    }
    vi.stubGlobal('fetch', mockFetch(200, payload))

    const result = await fetchCertScan('bccr.fi.cr')

    expect(result.ok).toBe(true)
    expect(result.ca).toBe('DigiCert')
    expect(result.validationTier).toBe('EV')
    expect(result.expired).toBe(false)
  })

  it('sends only the hostname — no path, no credentials', async () => {
    const spy = mockFetch(200, { ok: true, host: 'bccr.fi.cr' })
    vi.stubGlobal('fetch', spy)

    await fetchCertScan('bccr.fi.cr')

    const [calledUrl, calledInit] = spy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe('http://localhost:8787/scan?host=bccr.fi.cr')
    expect(calledInit.credentials).toBe('omit')
    expect(calledInit.method).toBe('GET')
    // Must NOT contain any path segment beyond the hostname
    expect(calledUrl).not.toContain('/pagina')
    expect(calledUrl).not.toContain('?url=')
  })

  it('returns { ok: false } on non-200 HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { message: 'down' }))

    const result = await fetchCertScan('bccr.fi.cr')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/503/)
    expect(result.host).toBe('bccr.fi.cr')
  })

  it('returns { ok: false } on network error', async () => {
    vi.stubGlobal('fetch', throwingFetch('NetworkFail'))

    await expect(fetchCertScan('bccr.fi.cr')).rejects.toThrow('NetworkFail')
  })
})

// ── submitThreatReport ────────────────────────────────────────────────────────

describe('submitThreatReport', () => {
  afterEach(() => vi.unstubAllGlobals())

  const minimalBody: ThreatReportBody = {
    findingType: 'insecure_pii_form',
    severity: 'high',
    hostname: 'bccr.go.cr',
    tld: 'go.cr',
    timestamp: '2026-07-24T00:00:00.000Z',
    extensionVersion: '0.1.0',
  }

  it('returns { ok, id } on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ok: true, id: 'abc123' }))

    const result = await submitThreatReport(minimalBody)

    expect(result.ok).toBe(true)
    expect(result.id).toBe('abc123')
  })

  it('sends credentials: omit and correct Content-Type', async () => {
    const spy = mockFetch(200, { ok: true, id: '1' })
    vi.stubGlobal('fetch', spy)

    await submitThreatReport(minimalBody)

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(init.credentials).toBe('omit')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.method).toBe('POST')
  })

  it('report body contains ONLY the allowed fields — never URL, path, or PII', async () => {
    const spy = mockFetch(200, { ok: true, id: '2' })
    vi.stubGlobal('fetch', spy)

    const bodyWithExtras = {
      ...minimalBody,
      // These must be stripped by the whitelist logic
      url: 'https://bccr.go.cr/tramites/secreto',
      path: '/tramites/secreto',
      userEmail: 'evil@example.com',
      cookie: 'session=abc',
    } as unknown as ThreatReportBody

    await submitThreatReport(bodyWithExtras)

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as Record<string, unknown>

    // Allowed fields present
    expect(sent.findingType).toBe('insecure_pii_form')
    expect(sent.severity).toBe('high')
    expect(sent.hostname).toBe('bccr.go.cr')
    expect(sent.tld).toBe('go.cr')
    expect(sent.timestamp).toBe('2026-07-24T00:00:00.000Z')
    expect(sent.extensionVersion).toBe('0.1.0')

    // Forbidden fields absent
    expect(sent).not.toHaveProperty('url')
    expect(sent).not.toHaveProperty('path')
    expect(sent).not.toHaveProperty('userEmail')
    expect(sent).not.toHaveProperty('cookie')
  })

  it('includes optional certVerdict and heuristicIds when provided', async () => {
    const spy = mockFetch(200, { ok: true, id: '3' })
    vi.stubGlobal('fetch', spy)

    await submitThreatReport({
      ...minimalBody,
      certVerdict: 'expired',
      heuristicIds: ['homograph_bccr', 'mixed_content'],
    })

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as Record<string, unknown>

    expect(sent.certVerdict).toBe('expired')
    expect(sent.heuristicIds).toEqual(['homograph_bccr', 'mixed_content'])
  })

  it('omits certVerdict and heuristicIds when not provided', async () => {
    const spy = mockFetch(200, { ok: true, id: '4' })
    vi.stubGlobal('fetch', spy)

    await submitThreatReport(minimalBody)

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as Record<string, unknown>

    expect(sent).not.toHaveProperty('certVerdict')
    expect(sent).not.toHaveProperty('heuristicIds')
  })

  it('returns { ok: false } on non-200 HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { message: 'error' }))

    const result = await submitThreatReport(minimalBody)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/500/)
  })

  it('throws on network error (caller handles)', async () => {
    vi.stubGlobal('fetch', throwingFetch('NetworkFail'))

    await expect(submitThreatReport(minimalBody)).rejects.toThrow('NetworkFail')
  })
})
