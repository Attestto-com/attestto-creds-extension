import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock chrome.storage APIs
const mockStorage: Record<string, Record<string, unknown>> = {
  local: {},
  session: {},
}

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: mockStorage.local[key] })),
      set: vi.fn(async (data: Record<string, unknown>) => {
        Object.assign(mockStorage.local, data)
      }),
    },
    session: {
      get: vi.fn(async (key: string) => ({ [key]: mockStorage.session[key] })),
      set: vi.fn(async (data: Record<string, unknown>) => {
        Object.assign(mockStorage.session, data)
      }),
    },
  },
})

describe('signing service', () => {
  let testPrivateKey: JsonWebKey

  beforeEach(async () => {
    // Generate a key pair and store it in the mock vault
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    testPrivateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

    // Generate encryption key
    const encKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const rawKey = await crypto.subtle.exportKey('raw', encKey)
    const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawKey)))

    // Encrypt vault data
    const vaultData = {
      did: 'did:key:zTest',
      privateKeyJwk: testPrivateKey,
      credentials: [],
    }
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(JSON.stringify(vaultData))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encKey,
      plaintext,
    )
    const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
    combined.set(iv)
    combined.set(new Uint8Array(ciphertext), iv.length)
    const encrypted = btoa(String.fromCharCode(...combined))

    mockStorage.local = { attestto_ext_vault: encrypted }
    mockStorage.session = { attestto_ext_session_key: keyBase64 }
  })

  afterEach(() => {
    mockStorage.local = {}
    mockStorage.session = {}
  })

  it('signs a payload and returns a base64 signature', async () => {
    const { signPayload } = await import('./signing')
    const payload = btoa('test data to sign')
    const result = await signPayload(payload)

    expect(result.ok).toBe(true)
    expect(result.signature).toBeTypeOf('string')
    expect(result.signature!.length).toBeGreaterThan(0)
  })

  it('returns error when vault is locked (no session key)', async () => {
    mockStorage.session = {}

    const { signPayload } = await import('./signing')
    const result = await signPayload(btoa('data'))

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('produces a verifiable signature', async () => {
    const { signPayload } = await import('./signing')
    const data = 'verify this roundtrip'
    const payload = btoa(data)
    const result = await signPayload(payload)

    expect(result.ok).toBe(true)

    // Build a public-only JWK (remove 'd' private component)
    const { d: _d, key_ops: _ops, ...publicJwk } = testPrivateKey
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...publicJwk, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    const sigBytes = Uint8Array.from(atob(result.signature!), (c) => c.charCodeAt(0))
    const dataBytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      dataBytes,
    )

    expect(valid).toBe(true)
  })
})
