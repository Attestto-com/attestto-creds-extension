import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  deriveKeyFromPassphrase,
  generateAndStoreSalt,
  readSalt,
} from './passphrase-kdf'

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

describe('passphrase-kdf', () => {
  it('rejects passphrases shorter than 8 characters', async () => {
    const salt = new Uint8Array(32)
    await expect(deriveKeyFromPassphrase('short', salt)).rejects.toThrow('at least 8 characters')
    await expect(deriveKeyFromPassphrase('', salt)).rejects.toThrow()
  })

  it('same passphrase + same salt = same key (deterministic)', async () => {
    const salt = new Uint8Array(32).fill(7)
    const k1 = await deriveKeyFromPassphrase('correct horse battery staple', salt)
    const k2 = await deriveKeyFromPassphrase('correct horse battery staple', salt)
    expect(k1).toBe(k2)
  })

  it('different passphrase → different key', async () => {
    const salt = new Uint8Array(32).fill(7)
    const k1 = await deriveKeyFromPassphrase('passphrase one', salt)
    const k2 = await deriveKeyFromPassphrase('passphrase two', salt)
    expect(k1).not.toBe(k2)
  })

  it('different salt → different key', async () => {
    const salt1 = new Uint8Array(32).fill(1)
    const salt2 = new Uint8Array(32).fill(2)
    const k1 = await deriveKeyFromPassphrase('same passphrase here', salt1)
    const k2 = await deriveKeyFromPassphrase('same passphrase here', salt2)
    expect(k1).not.toBe(k2)
  })

  it('derived key is standard base64 of a 32-byte value', async () => {
    const salt = new Uint8Array(32).fill(0)
    const key = await deriveKeyFromPassphrase('a valid passphrase', salt)
    // 32 bytes → 44-char base64 with single = padding
    expect(key).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const decoded = Uint8Array.from(atob(key), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(32)
  })

  it('normalizes passphrase NFKC (compatibility decomposition)', async () => {
    const salt = new Uint8Array(32).fill(5)
    // Two forms of "é": composed (U+00E9) and decomposed (e + U+0301)
    const composed = await deriveKeyFromPassphrase('café password', salt)
    const decomposed = await deriveKeyFromPassphrase('café password', salt)
    expect(composed).toBe(decomposed)
  })

  it('generateAndStoreSalt persists a 32-byte salt to chrome.storage.local', async () => {
    const salt = await generateAndStoreSalt()
    expect(salt).toBeInstanceOf(Uint8Array)
    expect(salt.length).toBe(32)
    const recovered = await readSalt()
    expect(recovered).toEqual(salt)
  })

  it('readSalt throws when no salt has been persisted', async () => {
    await expect(readSalt()).rejects.toThrow('No passphrase salt')
  })

  it('round-trip: store salt then derive same key in two calls', async () => {
    const salt = await generateAndStoreSalt()
    const k1 = await deriveKeyFromPassphrase('my secret passphrase', salt)
    const salt2 = await readSalt()
    const k2 = await deriveKeyFromPassphrase('my secret passphrase', salt2)
    expect(k1).toBe(k2)
  })
})
