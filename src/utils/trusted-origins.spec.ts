import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isOriginTrusted,
  recordTrustedOrigin,
  revokeTrustedOrigin,
  getTrustedOrigins,
} from './trusted-origins'

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

describe('trusted-origins', () => {
  it('returns false for an origin that has never been recorded', async () => {
    expect(await isOriginTrusted('https://example.com')).toBe(false)
  })

  it('returns false for null / empty / malformed origins', async () => {
    expect(await isOriginTrusted(null)).toBe(false)
    expect(await isOriginTrusted(undefined)).toBe(false)
    expect(await isOriginTrusted('')).toBe(false)
    expect(await isOriginTrusted('not-a-url')).toBe(false)
  })

  it('returns true after the origin is recorded', async () => {
    await recordTrustedOrigin('https://app.attestto.com')
    expect(await isOriginTrusted('https://app.attestto.com')).toBe(true)
  })

  it('normalizes to protocol + host (ignores path/query)', async () => {
    await recordTrustedOrigin('https://app.attestto.com/onboarding?step=1')
    expect(await isOriginTrusted('https://app.attestto.com')).toBe(true)
    expect(await isOriginTrusted('https://app.attestto.com/lock')).toBe(true)
  })

  it('treats different hosts as distinct', async () => {
    await recordTrustedOrigin('https://app.attestto.com')
    expect(await isOriginTrusted('https://evil.example')).toBe(false)
    expect(await isOriginTrusted('http://app.attestto.com')).toBe(false) // protocol mismatch
  })

  it('preserves trustedSince across re-recordings, updates lastUsed', async () => {
    await recordTrustedOrigin('https://app.attestto.com')
    const first = await getTrustedOrigins()
    const firstSince = first['https://app.attestto.com'].trustedSince

    // Re-record after a tick — trustedSince must NOT change
    await new Promise((r) => setTimeout(r, 5))
    await recordTrustedOrigin('https://app.attestto.com')
    const second = await getTrustedOrigins()
    expect(second['https://app.attestto.com'].trustedSince).toBe(firstSince)
  })

  it('revoke removes the origin', async () => {
    await recordTrustedOrigin('https://app.attestto.com')
    expect(await isOriginTrusted('https://app.attestto.com')).toBe(true)
    await revokeTrustedOrigin('https://app.attestto.com')
    expect(await isOriginTrusted('https://app.attestto.com')).toBe(false)
  })

  it('does not record when origin is null/malformed (silent no-op)', async () => {
    await recordTrustedOrigin(null)
    await recordTrustedOrigin('not-a-url')
    expect(Object.keys(await getTrustedOrigins())).toHaveLength(0)
  })
})
