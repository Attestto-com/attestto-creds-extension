import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  blockSite,
  isBlocked,
  getBlock,
  unblockSite,
  listBlocks,
} from './blocklist-store'

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

describe('blocklist-store', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
  })

  it('blocks a site with normalized host', async () => {
    const rec = await blockSite('https://BCCR.COM/path')
    expect(rec?.domain).toBe('bccr.com')
    expect(rec?.sharedWithCommunity).toBe(false)
    expect(rec?.blockedAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })

  it('returns null for invalid host', async () => {
    expect(await blockSite('')).toBeNull()
    expect(await blockSite(null)).toBeNull()
    expect(await blockSite('not a url')).toBeNull()
  })

  it('respects shareWithCommunity flag', async () => {
    const rec = await blockSite('example.com', { sharedWithCommunity: true, reason: 'phishing' })
    expect(rec?.sharedWithCommunity).toBe(true)
    expect(rec?.reason).toBe('phishing')
  })

  it('isBlocked / getBlock retrieve the record', async () => {
    await blockSite('bccr.com')
    expect(await isBlocked('bccr.com')).toBe(true)
    expect(await isBlocked('BCCR.COM')).toBe(true)
    expect(await isBlocked('other.com')).toBe(false)
    const rec = await getBlock('bccr.com')
    expect(rec?.domain).toBe('bccr.com')
  })

  it('unblockSite removes the record', async () => {
    await blockSite('bccr.com')
    await unblockSite('bccr.com')
    expect(await isBlocked('bccr.com')).toBe(false)
  })

  it('listBlocks returns sorted entries', async () => {
    await blockSite('zeta.com')
    await blockSite('alpha.com')
    await blockSite('beta.com')
    const list = await listBlocks()
    expect(list.map((r) => r.domain)).toEqual(['alpha.com', 'beta.com', 'zeta.com'])
  })

  it('re-blocking same host updates the record', async () => {
    const first = await blockSite('bccr.com', { reason: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const second = await blockSite('bccr.com', { reason: 'updated', sharedWithCommunity: true })
    expect(first?.reason).toBe('first')
    expect(second?.reason).toBe('updated')
    expect(second?.sharedWithCommunity).toBe(true)
    expect(await listBlocks()).toHaveLength(1)
  })
})
