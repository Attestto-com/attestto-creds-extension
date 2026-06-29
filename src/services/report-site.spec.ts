import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reportSite } from './report-site'
import * as blocklistStore from '@/utils/blocklist-store'

const store: Record<string, unknown> = {}

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (data: Record<string, unknown>) => {
        Object.assign(store, data)
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
})

describe('report-site', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.restoreAllMocks()
  })

  it('always adds the host to the local blocklist', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const result = await reportSite({ host: 'bccr.com' })
    expect(result.localBlocked).toBe(true)
    expect(result.sharedWithCommunity).toBe(false)
    expect(await blocklistStore.isBlocked('bccr.com')).toBe(true)
  })

  it('does NOT call the backend when shareWithCommunity is false (default)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await reportSite({ host: 'bccr.com' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('calls the backend ONLY when shareWithCommunity is true', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const result = await reportSite({
      host: 'bccr.com',
      reason: 'looks like BCCR',
      shareWithCommunity: true,
      collidedWithRegistryHost: 'bccr.fi.cr',
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(result.sharedWithCommunity).toBe(true)
    expect(result.shareError).toBeUndefined()

    // Verify payload shape
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/v1/anti-phishing/reports')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    const body = JSON.parse(init.body as string)
    expect(body.host).toBe('bccr.com')
    expect(body.reason).toBe('looks like BCCR')
    expect(body.collidedWithRegistryHost).toBe('bccr.fi.cr')
  })

  it('graceful-fails on backend error — local block still wins', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    const result = await reportSite({ host: 'bccr.com', shareWithCommunity: true })
    expect(result.localBlocked).toBe(true)
    expect(result.sharedWithCommunity).toBe(false)
    expect(result.shareError).toMatch(/500/)
    expect(await blocklistStore.isBlocked('bccr.com')).toBe(true)
  })

  it('graceful-fails on network throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NetworkFail') }))
    const result = await reportSite({ host: 'bccr.com', shareWithCommunity: true })
    expect(result.localBlocked).toBe(true)
    expect(result.sharedWithCommunity).toBe(false)
    expect(result.shareError).toBe('NetworkFail')
  })

  it('persists shareWithCommunity choice in the blocklist record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await reportSite({ host: 'bccr.com', shareWithCommunity: true })
    const rec = await blocklistStore.getBlock('bccr.com')
    expect(rec?.sharedWithCommunity).toBe(true)
  })
})
