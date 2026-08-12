/**
 * Story 1.13 Phase 5 — credential-offer acceptance.
 *
 * The referent throughout is the WRITTEN ARTEFACT: the exact vault objects handed
 * to the store, captured whole. Asserting "the handler called write" would pass
 * for a handler that wrote the wrong thing; asserting the serialized record
 * catches a claim landing in the wrong field, an identity minted from the wrong
 * format, or a partial write after a decode failure.
 *
 * Every write is recorded in call order, so "nothing was written" is a real,
 * checkable claim rather than the absence of an assertion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  handleCredentialOfferAccept,
  upsertIdentity,
  type CredentialOfferAcceptCtx,
} from './credential-offer-accept.handler'
import type { VaultData } from '@/stores/wallet'
import type { PublicVaultData } from '@/utils/vault'
import type { StoredCredential } from '@/types/credential'
import type { CredentialOfferMessage } from '@/utils/messaging'

type Offer = CredentialOfferMessage['payload']

const NOW = '2026-08-08T12:00:00.000Z'
const NEW_ID = 'cred-uuid-1'

interface Harness {
  ctx: CredentialOfferAcceptCtx
  writes: { target: 'public' | 'vault' | 'syncPublic'; vault: PublicVaultData | VaultData }[]
  trusted: string[]
}

function harness(opts: { publicVault?: PublicVaultData | null; vault?: VaultData | null } = {}): Harness {
  const writes: Harness['writes'] = []
  const trusted: string[] = []
  const publicVault = opts.publicVault === undefined ? null : opts.publicVault
  const vault = opts.vault === undefined ? null : opts.vault

  return {
    writes,
    trusted,
    ctx: {
      store: {
        readPublic: async () => publicVault,
        writePublic: async (v) => {
          writes.push({ target: 'public', vault: structuredClone(v) })
        },
        read: async () => vault,
        write: async (v) => {
          writes.push({ target: 'vault', vault: structuredClone(v) })
        },
        syncPublic: async (v) => {
          writes.push({ target: 'syncPublic', vault: structuredClone(v) })
        },
      },
      origins: {
        recordTrusted: async (origin) => {
          trusted.push(origin)
        },
      },
      clock: { nowIso: () => NOW },
      newId: () => NEW_ID,
    },
  }
}

function emptyPublic(): PublicVaultData {
  return {
    did: null,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
  }
}

/**
 * The encrypted vault is NOT the public mirror with one extra field — its
 * `siteDids` entries carry private key material the public type has no room for.
 * Spelling both out separately is the point, not boilerplate.
 */
function emptyEncrypted(): VaultData {
  return {
    did: null,
    privateKeyJwk: null,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
  }
}

const identityOffer = (claims: Record<string, unknown>): Offer =>
  ({
    format: 'attestto-id',
    issuerName: 'Attestto',
    raw: 'not-json',
    claims,
  })

const jsonLdOffer = (vc: Record<string, unknown>): Offer =>
  ({
    format: 'json-ld',
    issuerName: 'Fallback Issuer',
    raw: JSON.stringify(vc),
  })

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('what lands in the vaults', () => {
  it('writes one fully-formed credential to the public mirror', async () => {
    const h = harness()
    const id = await handleCredentialOfferAccept(
      { offer: jsonLdOffer({ type: ['VerifiableCredential', 'EmploymentCredential'], issuer: 'did:web:muni.go.cr', issuanceDate: '2026-01-01T00:00:00Z', expirationDate: '2027-01-01T00:00:00Z', credentialSubject: { role: 'Alcalde' } }), origin: 'https://muni.go.cr' },
      h.ctx,
    )

    expect(id).toBe(NEW_ID)
    expect(h.writes.map((w) => w.target)).toEqual(['public'])
    expect(h.writes[0].vault.credentials).toEqual([
      {
        id: NEW_ID,
        format: 'json-ld',
        raw: expect.any(String),
        issuer: 'did:web:muni.go.cr',
        issuedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2027-01-01T00:00:00Z',
        types: ['VerifiableCredential', 'EmploymentCredential'],
        decodedClaims: { role: 'Alcalde' },
        metadata: { addedAt: NOW, source: 'push', disclosureDigests: undefined },
      } satisfies StoredCredential,
    ])
  })

  it('creates the public mirror when there is none, instead of dropping the offer', async () => {
    const h = harness({ publicVault: null })
    await handleCredentialOfferAccept({ offer: jsonLdOffer({ credentialSubject: {} }), origin: null }, h.ctx)
    expect(h.writes[0].vault.credentials).toHaveLength(1)
  })

  it('appends to an existing mirror rather than replacing it', async () => {
    const existing = emptyPublic()
    existing.credentials = [{ id: 'older' } as StoredCredential]
    const h = harness({ publicVault: existing })

    await handleCredentialOfferAccept({ offer: jsonLdOffer({ credentialSubject: {} }), origin: null }, h.ctx)

    expect(h.writes[0].vault.credentials.map((c) => c.id)).toEqual(['older', NEW_ID])
  })

  it('mirrors into the encrypted vault when it is unlocked, then re-syncs the public copy', async () => {
    const h = harness({ vault: emptyEncrypted() })
    await handleCredentialOfferAccept({ offer: jsonLdOffer({ credentialSubject: {} }), origin: null }, h.ctx)

    expect(h.writes.map((w) => w.target)).toEqual(['public', 'vault', 'syncPublic'])
    expect(h.writes[1].vault.credentials.map((c) => c.id)).toEqual([NEW_ID])
  })

  it('touches only the public mirror when the vault is locked', async () => {
    const h = harness({ vault: null })
    await handleCredentialOfferAccept({ offer: jsonLdOffer({ credentialSubject: {} }), origin: null }, h.ctx)
    expect(h.writes.map((w) => w.target)).toEqual(['public'])
  })
})

describe('trust-on-first-use is scoped to the identity format', () => {
  it('records the origin for an attestto-id offer', async () => {
    const h = harness()
    await handleCredentialOfferAccept({ offer: identityOffer({ didUri: 'did:sns:a.attestto.sol' }), origin: 'https://app.attestto.com' }, h.ctx)
    expect(h.trusted).toEqual(['https://app.attestto.com'])
  })

  it('does NOT grant a one-off json-ld issuer standing silent-sync permission', async () => {
    const h = harness()
    await handleCredentialOfferAccept({ offer: jsonLdOffer({ credentialSubject: {} }), origin: 'https://issuer.example' }, h.ctx)
    expect(h.trusted).toEqual([])
  })

  it('does NOT grant an sd-jwt issuer standing permission either', async () => {
    const h = harness()
    const offer = { format: 'sd-jwt', issuerName: 'I', raw: 'garbage' } as unknown as Offer
    await handleCredentialOfferAccept({ offer, origin: 'https://issuer.example' }, h.ctx)
    expect(h.trusted).toEqual([])
  })

  it('records nothing when the identity offer carried no origin', async () => {
    const h = harness()
    await handleCredentialOfferAccept({ offer: identityOffer({ didUri: 'did:sns:a.attestto.sol' }), origin: null }, h.ctx)
    expect(h.trusted).toEqual([])
  })
})

describe('only an identity offer may mint a linked identity', () => {
  it('an attestto-id offer creates the linked identity with a derived label', async () => {
    const h = harness()
    await handleCredentialOfferAccept(
      { offer: identityOffer({ didUri: 'did:sns:chongkan.attestto.sol' }), origin: 'https://app.attestto.com' },
      h.ctx,
    )
    expect(h.writes[0].vault.linkedIdentities).toEqual([
      {
        did: 'did:sns:chongkan.attestto.sol',
        label: expect.any(String),
        credentials: [expect.objectContaining({ id: NEW_ID })],
        syncedAt: NOW,
        tenantId: null,
      },
    ])
  })

  it('a json-ld VC smuggling didUri in credentialSubject creates NO identity', async () => {
    const h = harness()
    await handleCredentialOfferAccept(
      { offer: jsonLdOffer({ credentialSubject: { didUri: 'did:sns:attacker.attestto.sol' } }), origin: 'https://evil.example' },
      h.ctx,
    )
    expect(h.writes[0].vault.linkedIdentities).toBeUndefined()
    expect(JSON.stringify(h.writes)).not.toContain('linkedIdentities')
  })

  it('an identity offer without a didUri stores the credential but no identity', async () => {
    const h = harness()
    await handleCredentialOfferAccept({ offer: identityOffer({ name: 'no did here' }), origin: 'https://app.attestto.com' }, h.ctx)
    expect(h.writes[0].vault.credentials).toHaveLength(1)
    expect(h.writes[0].vault.linkedIdentities).toBeUndefined()
  })

  it('mints the identity in the encrypted vault too when it is unlocked', async () => {
    const h = harness({ vault: emptyEncrypted() })
    await handleCredentialOfferAccept({ offer: identityOffer({ didUri: 'did:sns:a.attestto.sol' }), origin: null }, h.ctx)
    const encrypted = h.writes.find((w) => w.target === 'vault')
    expect(encrypted?.vault.linkedIdentities?.[0]?.did).toBe('did:sns:a.attestto.sol')
  })
})

describe('a decode failure writes nothing', () => {
  it('returns null and leaves both vaults untouched when sd-jwt parsing throws', async () => {
    const h = harness({ vault: emptyEncrypted() })
    const offer = { format: 'sd-jwt', issuerName: 'I', raw: 'not~a~sd-jwt' } as unknown as Offer

    const id = await handleCredentialOfferAccept({ offer, origin: null }, h.ctx)

    expect(id).toBeNull()
    expect(h.writes).toEqual([])
  })

  it('returns null and writes nothing when the public write itself fails', async () => {
    const h = harness()
    h.ctx.store.writePublic = async () => {
      throw new Error('quota exceeded')
    }
    const id = await handleCredentialOfferAccept({ offer: jsonLdOffer({ credentialSubject: {} }), origin: null }, h.ctx)
    expect(id).toBeNull()
    expect(h.writes).toEqual([])
  })

  it('falls back to the raw claims object when an attestto-id payload is not JSON', async () => {
    const h = harness()
    const id = await handleCredentialOfferAccept({ offer: identityOffer({ didUri: 'did:sns:a.attestto.sol', tenant: 'nicoya' }), origin: null }, h.ctx)
    expect(id).toBe(NEW_ID)
    expect(h.writes[0].vault.credentials[0].decodedClaims).toEqual({ didUri: 'did:sns:a.attestto.sol', tenant: 'nicoya' })
  })
})

describe('upsertIdentity', () => {
  const cred = (id: string): StoredCredential => ({ id }) as StoredCredential

  it('appends a new identity with the injected timestamp', () => {
    const out = upsertIdentity([], 'did:sns:a.attestto.sol', cred('c1'), NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ did: 'did:sns:a.attestto.sol', syncedAt: NOW, tenantId: null })
    expect(out[0].credentials.map((c) => c.id)).toEqual(['c1'])
  })

  it('adds a second credential to an identity already present', () => {
    const first = upsertIdentity([], 'did:x', cred('c1'), NOW)
    const second = upsertIdentity(first, 'did:x', cred('c2'), '2026-09-09T00:00:00.000Z')
    expect(second).toHaveLength(1)
    expect(second[0].credentials.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(second[0].syncedAt).toBe('2026-09-09T00:00:00.000Z')
  })

  it('re-syncing the SAME credential does not duplicate it', () => {
    const first = upsertIdentity([], 'did:x', cred('c1'), NOW)
    const again = upsertIdentity(first, 'did:x', cred('c1'), NOW)
    expect(again[0].credentials.map((c) => c.id)).toEqual(['c1'])
  })

  it('leaves other identities untouched', () => {
    const list = upsertIdentity(upsertIdentity([], 'did:a', cred('c1'), NOW), 'did:b', cred('c2'), NOW)
    const out = upsertIdentity(list, 'did:a', cred('c3'), NOW)
    expect(out.map((i) => i.did)).toEqual(['did:a', 'did:b'])
    expect(out[1].credentials.map((c) => c.id)).toEqual(['c2'])
  })

  it('does not mutate the list it was given', () => {
    const list = upsertIdentity([], 'did:a', cred('c1'), NOW)
    const snapshot = structuredClone(list)
    upsertIdentity(list, 'did:a', cred('c2'), NOW)
    expect(list).toEqual(snapshot)
  })
})
