import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getPreferredIdentity,
  setPreferredIdentity,
  clearPreferredIdentity,
  getAllPreferences,
} from './site-identity-prefs'

const mockStorage: Record<string, Record<string, unknown>> = { local: {} }

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: mockStorage.local[key] })),
      set: vi.fn(async (data: Record<string, unknown>) => {
        Object.assign(mockStorage.local, data)
      }),
    },
  },
})

beforeEach(() => {
  mockStorage.local = {}
})

describe('site-identity-prefs', () => {
  it('returns null when no preference exists', async () => {
    expect(await getPreferredIdentity('https://example.com')).toBe(null)
  })

  it('returns null for null/malformed origin', async () => {
    expect(await getPreferredIdentity(null)).toBe(null)
    expect(await getPreferredIdentity(undefined)).toBe(null)
    expect(await getPreferredIdentity('not-a-url')).toBe(null)
  })

  it('round-trips a preference', async () => {
    await setPreferredIdentity('https://app.attestto.com', 'did:sns:chongkan.attestto.sol')
    expect(await getPreferredIdentity('https://app.attestto.com')).toBe(
      'did:sns:chongkan.attestto.sol',
    )
  })

  it('normalizes to protocol + host (ignores path/query)', async () => {
    await setPreferredIdentity('https://app.attestto.com/profile?x=1', 'did:sns:a.attestto.sol')
    expect(await getPreferredIdentity('https://app.attestto.com')).toBe(
      'did:sns:a.attestto.sol',
    )
  })

  it('overwrites on re-set', async () => {
    await setPreferredIdentity('https://x.com', 'did:jwk:abc')
    await setPreferredIdentity('https://x.com', 'did:sns:b.attestto.sol')
    expect(await getPreferredIdentity('https://x.com')).toBe('did:sns:b.attestto.sol')
  })

  it('clears a preference', async () => {
    await setPreferredIdentity('https://x.com', 'did:jwk:abc')
    await clearPreferredIdentity('https://x.com')
    expect(await getPreferredIdentity('https://x.com')).toBe(null)
  })

  it('getAllPreferences returns the full map', async () => {
    await setPreferredIdentity('https://a.com', 'did:sns:a.attestto.sol')
    await setPreferredIdentity('https://b.com', 'did:sns:b.attestto.sol')
    const all = await getAllPreferences()
    expect(all).toEqual({
      'https://a.com': 'did:sns:a.attestto.sol',
      'https://b.com': 'did:sns:b.attestto.sol',
    })
  })

  it('silently no-ops on null/malformed origin in set', async () => {
    await setPreferredIdentity(null, 'did:sns:x.attestto.sol')
    await setPreferredIdentity('not-a-url', 'did:sns:x.attestto.sol')
    expect(Object.keys(await getAllPreferences())).toHaveLength(0)
  })
})
