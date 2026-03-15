import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { StoredCredential } from '@/types/credential'

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

function makeCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: crypto.randomUUID(),
    format: 'sd-jwt',
    raw: 'eyJ0eXAiOiJ2YytzZC1qd3QifQ.test.sig~disc1~',
    issuer: 'did:key:zIssuer',
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    types: ['VerifiableCredential', 'TestCredential'],
    decodedClaims: { name: 'Alice', age: 30 },
    metadata: {
      addedAt: '2026-01-15T00:00:00Z',
      source: 'push',
    },
    ...overrides,
  }
}

async function setupEncryptedVault(
  credentials: StoredCredential[] = [],
): Promise<void> {
  const encKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  const rawKey = await crypto.subtle.exportKey('raw', encKey)
  const keyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawKey)))

  const vaultData = {
    did: 'did:key:zTest',
    privateKeyJwk: null,
    credentials,
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
}

describe('credentials store', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    mockStorage.local = {}
    mockStorage.session = {}
  })

  afterEach(() => {
    mockStorage.local = {}
    mockStorage.session = {}
  })

  it('loads credentials from vault', async () => {
    const cred = makeCredential()
    await setupEncryptedVault([cred])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    expect(store.credentials).toHaveLength(1)
    expect(store.credentials[0].id).toBe(cred.id)
  })

  it('returns empty array when vault has no credentials', async () => {
    await setupEncryptedVault([])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    expect(store.credentials).toHaveLength(0)
  })

  it('adds a credential and persists to vault', async () => {
    await setupEncryptedVault([])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    const cred = makeCredential()
    await store.addCredential(cred)

    expect(store.credentials).toHaveLength(1)
    expect(store.credentials[0].id).toBe(cred.id)

    // Verify persistence by reading vault again
    const { readVault } = await import('@/utils/vault')
    const vault = await readVault()
    expect(vault?.credentials).toHaveLength(1)
  })

  it('removes a credential by ID', async () => {
    const cred1 = makeCredential({ id: 'keep-me' })
    const cred2 = makeCredential({ id: 'delete-me' })
    await setupEncryptedVault([cred1, cred2])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    expect(store.credentials).toHaveLength(2)

    await store.removeCredential('delete-me')

    expect(store.credentials).toHaveLength(1)
    expect(store.credentials[0].id).toBe('keep-me')
  })

  it('getById returns the correct credential', async () => {
    const cred = makeCredential({ id: 'find-me' })
    await setupEncryptedVault([cred])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    const found = store.getById('find-me')
    expect(found).toBeDefined()
    expect(found!.issuer).toBe(cred.issuer)
  })

  it('getById returns undefined for non-existent ID', async () => {
    await setupEncryptedVault([])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    expect(store.getById('nope')).toBeUndefined()
  })

  it('clearOnLock wipes in-memory state', async () => {
    const cred = makeCredential()
    await setupEncryptedVault([cred])

    const { useCredentialsStore } = await import('./credentials')
    const store = useCredentialsStore()
    await store.loadFromVault()

    expect(store.credentials).toHaveLength(1)

    store.clearOnLock()

    expect(store.credentials).toHaveLength(0)
  })
})
