import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// Mock the WebAuthn primitives so we can assert which one createDid routes
// through without touching a real authenticator.
vi.mock('@/utils/webauthn', () => ({
  setupPasskey: vi.fn(),
  unlockWithPasskey: vi.fn(),
  hasPasskey: vi.fn(),
  getKdfMethod: vi.fn(),
}))

import { migrateVaultToMultiIdentity, useWalletStore, type VaultData, type LinkedIdentity } from './wallet'
import { setupPasskey, unlockWithPasskey, hasPasskey } from '@/utils/webauthn'

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:test',
    privateKeyJwk: null,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    ...overrides,
  }
}

describe('migrateVaultToMultiIdentity', () => {
  it('creates empty linkedIdentities when no holderDid', () => {
    const vault = makeVault()
    const result = migrateVaultToMultiIdentity(vault)

    expect(result.linkedIdentities).toEqual([])
  })

  it('skips migration if linkedIdentities already exists', () => {
    const existing: LinkedIdentity[] = [
      {
        did: 'did:sns:alice.attestto.sol',
        label: 'alice.attestto.sol',
        credentials: [],
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    const vault = makeVault({ linkedIdentities: existing })
    const result = migrateVaultToMultiIdentity(vault)

    expect(result.linkedIdentities).toBe(existing)
    expect(result.linkedIdentities).toHaveLength(1)
  })

  it('migrates holderDid (did:sns) to linkedIdentities', () => {
    const vault = makeVault({
      holderDid: 'did:sns:chongkan.attestto.sol',
      verificationMethod: 'did:sns:chongkan.attestto.sol#key-1',
      credentials: [
        {
          id: 'cred-1',
          format: 'sd-jwt',
          raw: 'test',
          issuer: 'test-issuer',
          issuedAt: '2026-01-01',
          expiresAt: null,
          types: ['VerifiableCredential'],
          decodedClaims: {},
          metadata: { addedAt: '2026-01-01', source: 'push' },
        },
      ],
    })

    const result = migrateVaultToMultiIdentity(vault)

    expect(result.linkedIdentities).toHaveLength(1)
    expect(result.linkedIdentities![0].did).toBe('did:sns:chongkan.attestto.sol')
    expect(result.linkedIdentities![0].label).toBe('chongkan.attestto.sol')
    expect(result.linkedIdentities![0].verificationMethod).toBe('did:sns:chongkan.attestto.sol#key-1')
    expect(result.linkedIdentities![0].credentials).toHaveLength(1)
    expect(result.linkedIdentities![0].credentials[0].id).toBe('cred-1')
  })

  it('migrates holderDid (did:web) to linkedIdentities', () => {
    const vault = makeVault({
      holderDid: 'did:web:attestto.com:users:42',
    })

    const result = migrateVaultToMultiIdentity(vault)

    expect(result.linkedIdentities).toHaveLength(1)
    expect(result.linkedIdentities![0].did).toBe('did:web:attestto.com:users:42')
    expect(result.linkedIdentities![0].label).toBe('attestto.com/users/42')
  })

  it('ignores did:jwk holderDid (not a platform identity)', () => {
    const vault = makeVault({
      holderDid: 'did:jwk:eyJrdHkiOiJFQyJ9',
    })

    const result = migrateVaultToMultiIdentity(vault)

    expect(result.linkedIdentities).toEqual([])
  })

  it('is idempotent — calling twice returns same result', () => {
    const vault = makeVault({
      holderDid: 'did:sns:test.attestto.sol',
    })

    const first = migrateVaultToMultiIdentity(vault)
    const second = migrateVaultToMultiIdentity(first)

    expect(second.linkedIdentities).toBe(first.linkedIdentities)
    expect(second.linkedIdentities).toHaveLength(1)
  })
})

describe('createDid — PRF create-path routing (ATT-1128 regression)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // The bug: createDid used unlockWithPasskey whenever a passkey credential was
  // already registered. setupPasskey persists the credential id BEFORE setup
  // finishes, so an aborted prior attempt leaves an orphan credential with no
  // vault / no recorded KDF method. Routing that through unlockWithPasskey made
  // it default to PRF, get no PRF secret on a non-PRF authenticator, and throw
  // the UNRECOVERABLE "PRF_UNAVAILABLE: ... legacy vault ... must be reset" —
  // surfaced as a raw red banner on a fresh "No DID created yet" screen.
  it('routes through setupPasskey (recoverable PRF_REQUIRES_PASSPHRASE), never unlockWithPasskey/PRF_UNAVAILABLE, even when a passkey credential already exists', async () => {
    // Orphan credential from a prior aborted attempt is present.
    vi.mocked(hasPasskey).mockResolvedValue(true)
    // Non-PRF authenticator, no passphrase supplied yet → setup asks for one.
    vi.mocked(setupPasskey).mockRejectedValue(
      new Error('PRF_REQUIRES_PASSPHRASE: This authenticator does not support WebAuthn PRF.'),
    )
    // If createDid ever calls this, it would surface the unrecoverable reset error.
    vi.mocked(unlockWithPasskey).mockRejectedValue(
      new Error('PRF_UNAVAILABLE: ... the wallet must be reset.'),
    )

    const wallet = useWalletStore()

    await expect(wallet.createDid()).rejects.toThrow('PRF_REQUIRES_PASSPHRASE')
    // The heart of the fix: the create path must NOT use the unlock primitive.
    expect(unlockWithPasskey).not.toHaveBeenCalled()
    expect(setupPasskey).toHaveBeenCalledTimes(1)
  })

  it('routes a retry through setupPasskey, never unlockWithPasskey', async () => {
    vi.mocked(hasPasskey).mockResolvedValue(true)
    // Reject so we stop before the crypto/vault machinery; we only assert routing.
    vi.mocked(setupPasskey).mockRejectedValue(new Error('stop-after-routing'))

    const wallet = useWalletStore()

    await expect(wallet.createDid()).rejects.toThrow('stop-after-routing')
    expect(setupPasskey).toHaveBeenCalledWith()
    // unlockWithPasskey assumes a vault already exists and would surface the
    // terminal "reset the wallet" error on a fresh create screen.
    expect(unlockWithPasskey).not.toHaveBeenCalled()
  })
})
