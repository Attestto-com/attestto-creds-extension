import { describe, it, expect } from 'vitest'
import { migrateVaultToMultiIdentity, type VaultData, type LinkedIdentity } from './wallet'

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
