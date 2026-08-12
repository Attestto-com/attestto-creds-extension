/**
 * Story 1.7 — public-vault field allowlist (PII out of the mirror), SM2/FR1/FR2.
 *
 * The PRIMARY guarantee is a DEEP leak-detector: plant known-PII sentinels in
 * every place credential PII lives — root `credentials[].decodedClaims`, root
 * `credentials[].raw`, AND the nested `linkedIdentities[].credentials[]` of each
 * — then assert the serialized public projection contains NONE of them. A shallow
 * `Object.keys(pub)` check misses the nested path, which is the exact leak this
 * story exists to close (Redline). Sentinels are obviously-fake (no real PII).
 *
 * `toPublicVault`/`toPublicCredential` are pure (no chrome) — tested directly.
 */
import { describe, it, expect } from 'vitest'
import { toPublicVault, toPublicCredential, PUBLIC_CREDENTIAL_KEYS } from './vault'
import type { VaultData, LinkedIdentity } from '@/stores/wallet'
import type { StoredCredential } from '@/types/credential'

// ── sentinels: if any appears in the serialized public vault, PII leaked ───────
const CEDULA = 'CEDULA-SENTINEL-101100999'
const DOB = 'DOB-SENTINEL-1970-01-01'
const NAME = 'NAME-SENTINEL-Jane-Q-Public'
const RAW_ROOT = 'RAW-JWT-SENTINEL-root.eyJwaWkiOiJsZWFrIn0'
const RAW_NESTED = 'RAW-JWT-SENTINEL-nested.eyJwaWkiOiJsZWFrIn0'
const PRIV_KEY = 'PRIVATE-KEY-D-SENTINEL'
const SITE_KEY = 'SITE-PRIVATE-KEY-D-SENTINEL' // per-site P-256 key — must not mirror

function credWithPii(id: string, rawSentinel: string, claim: Record<string, unknown>): StoredCredential {
  return {
    id,
    format: 'sd-jwt',
    raw: rawSentinel, // ← the token itself carries disclosures (PII)
    issuer: 'https://gob.cr',
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2031-01-01T00:00:00Z',
    types: ['VerifiableCredential', 'NationalID'],
    decodedClaims: { cedula: CEDULA, ...claim }, // ← decoded PII
    metadata: { addedAt: '2026-01-01T00:00:00Z', source: 'push', disclosureDigests: ['abc'] },
  }
}

function vaultWithPiiEverywhere(): VaultData {
  const rootCred = credWithPii('root-cred', RAW_ROOT, { dob: DOB })
  const nestedCred = credWithPii('nested-cred', RAW_NESTED, { name: NAME })
  const identity: LinkedIdentity = {
    did: 'did:sns:jane.attestto.sol',
    label: 'jane.attestto.sol',
    verificationMethod: 'did:web:attestto.com#k1',
    credentials: [nestedCred], // ← the nested path — the easy miss
    syncedAt: '2026-01-01T00:00:00Z',
    tenantId: null,
  }
  return {
    did: 'did:jwk:local',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', d: PRIV_KEY, x: 'X', y: 'Y' },
    ed25519PrivateKeyJwk: { kty: 'OKP', crv: 'Ed25519', d: PRIV_KEY },
    ed25519PublicKeyB64: 'PUB',
    credentials: [rootCred],
    linkedSolanaAddress: 'SoLAddr',
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    verificationMethod: 'did:jwk:local#0',
    holderDid: 'did:sns:jane.attestto.sol',
    linkedIdentities: [identity],
    siteDids: {
      'https://x.example': {
        did: 'did:jwk:site',
        privateKeyJwk: { kty: 'EC', crv: 'P-256', d: SITE_KEY },
        createdAt: 'a',
        lastUsedAt: 'b',
      },
    },
  }
}

describe('toPublicVault — deep leak-detector (SM2: zero decoded-PII at rest)', () => {
  const serialized = JSON.stringify(toPublicVault(vaultWithPiiEverywhere()))

  it.each([
    ['root decodedClaims (cédula)', CEDULA],
    ['root decodedClaims (DOB)', DOB],
    ['nested identity decodedClaims (name)', NAME],
    ['root credential raw token', RAW_ROOT],
    ['NESTED credential raw token', RAW_NESTED],
    ['private signing key', PRIV_KEY],
    ['per-site private key', SITE_KEY],
  ])('does not leak %s anywhere in the serialized public vault', (_label, sentinel) => {
    expect(serialized).not.toContain(sentinel)
  })

  it('does not carry the private-key FIELD names either', () => {
    expect(serialized).not.toContain('privateKeyJwk')
    expect(serialized).not.toContain('ed25519PrivateKeyJwk')
  })
})

describe('toPublicCredential — strips PII but keeps a well-formed card (positive control)', () => {
  const pub = toPublicCredential(credWithPii('c1', RAW_ROOT, { dob: DOB }))

  it('keeps non-PII card metadata (not a vacuous drop-everything)', () => {
    expect(pub.id).toBe('c1')
    expect(pub.issuer).toBe('https://gob.cr')
    expect(pub.types).toContain('NationalID')
    expect(pub.issuedAt).toBe('2026-01-01T00:00:00Z')
    expect(pub.expiresAt).toBe('2031-01-01T00:00:00Z')
    expect(pub.format).toBe('sd-jwt')
  })

  it('neutralizes decodedClaims and raw (no PII value survives)', () => {
    expect(pub.decodedClaims).toEqual({})
    expect(pub.raw).toBe('')
  })

  it('carries no key outside the public allowlist (construct-only, FR1)', () => {
    // A newly-added StoredCredential field must NOT appear here (defaults private).
    expect(Object.keys(pub).sort()).toEqual([...PUBLIC_CREDENTIAL_KEYS].sort())
  })

  it('drops sensitive metadata sub-fields (disclosureDigests), keeps display ones', () => {
    expect(pub.metadata).toEqual({ addedAt: '2026-01-01T00:00:00Z', source: 'push' })
  })
})

describe('toPublicVault — nested identity credentials are ALSO projected', () => {
  const pub = toPublicVault(vaultWithPiiEverywhere())

  it('runs every linkedIdentities[].credentials through the same strip', () => {
    const nested = pub.linkedIdentities![0].credentials[0]
    expect(nested.decodedClaims).toEqual({})
    expect(nested.raw).toBe('')
    expect(nested.id).toBe('nested-cred') // card metadata preserved
  })

  it('private keys never mirrored (FR20 positive control, no regression)', () => {
    expect('privateKeyJwk' in pub).toBe(false)
    expect('ed25519PrivateKeyJwk' in pub).toBe(false)
  })
})
