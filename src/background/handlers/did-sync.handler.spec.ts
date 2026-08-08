/**
 * Story 1.10 — characterization of `handleDidSync`, transcribed from the legacy
 * switch behavior (`background.ts:1035-1104`) FIRST; the extracted handler passes
 * it unchanged (parity-to-legacy is the AC, not "the handler works").
 *
 * Referents are independent per edge (write spy / keygen spy / call-order array /
 * the RETURNED response data / the REAL `toPublicVault` projection). The two
 * positive controls are asserted directly:
 *   - public-key strip  → the response `publicKeyJwk` has no `d` (private field).
 *   - keys-never-mirrored → the vault the handler hands to `syncPublic`, run through
 *     the real Story-1.7 `toPublicVault`, carries no private key. This is a
 *     COMPOSITION tripwire (the strip itself is 1.7's tested code): it reddens iff
 *     the handler is ever rewired to mirror around the strip.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleDidSync } from './did-sync.handler'
import { publicJwkToDid } from '@/utils/did-jwk'
import { toPublicVault } from '@/utils/vault'
import type { VaultData } from '@/stores/wallet'
import type { PublicVaultData } from '@/utils/vault'
import type { DidSyncMessage } from '@/utils/messaging'

const NEW_PUB: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'NEW_X', y: 'NEW_Y' }
const NEW_PRIV: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'NEW_X', y: 'NEW_Y', d: 'NEW_SECRET' }
const CLOCK_MS = 1_700_000_000_000
const CLOCK_ISO = new Date(CLOCK_MS).toISOString()

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:existing',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'OLD_X', y: 'OLD_Y', d: 'OLD_SECRET' } as JsonWebKey,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    linkedIdentities: [],
    ...overrides,
  }
}

function makePayload(overrides: Partial<DidSyncMessage['payload']> = {}): DidSyncMessage['payload'] {
  return {
    requestId: 'req-1',
    holderDid: 'did:sns:alice.attestto.sol',
    verificationMethod: 'did:sns:alice.attestto.sol#key-1',
    origin: 'https://app.attestto.com',
    ...overrides,
  }
}

function makeCtx(vault: VaultData | null) {
  const order: string[] = []
  const writes: VaultData[] = []
  const mirrors: PublicVaultData[] = []
  const keygen = vi.fn(async () => ({ privateKeyJwk: NEW_PRIV, publicKeyJwk: NEW_PUB }))
  const write = vi.fn(async (v: VaultData) => {
    order.push('write')
    writes.push(v)
  })
  const syncPublic = vi.fn(async (v: VaultData) => {
    order.push('syncPublic')
    mirrors.push(toPublicVault(v)) // the REAL Story-1.7 strip
  })
  const ctx = {
    store: { read: vi.fn(async () => vault), write, syncPublic },
    keygen: { generateP256: keygen },
    clock: { now: () => CLOCK_MS },
  }
  return { ctx, order, writes, mirrors, keygen }
}

describe('handleDidSync — characterization (parity-to-legacy)', () => {
  it('new identity, key already present: upserts, mirrors, returns stripped pubkey', async () => {
    const vault = makeVault()
    const { ctx, order, writes, keygen } = makeCtx(vault)

    const result = await handleDidSync(makePayload(), ctx)

    // keypair NOT regenerated when a key exists (guard referent)
    expect(keygen).not.toHaveBeenCalled()

    // response data
    expect(result).toEqual({
      requestId: 'req-1',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'OLD_X', y: 'OLD_Y' },
      holderDid: 'did:sns:alice.attestto.sol',
      error: null,
    })

    // new linkedIdentity row
    const written = writes[0]
    expect(written.linkedIdentities).toEqual([
      {
        did: 'did:sns:alice.attestto.sol',
        label: 'alice.attestto.sol',
        verificationMethod: 'did:sns:alice.attestto.sol#key-1',
        credentials: [],
        syncedAt: CLOCK_ISO,
        tenantId: null,
      },
    ])
    // legacy back-compat fields
    expect(written.holderDid).toBe('did:sns:alice.attestto.sol')
    expect(written.verificationMethod).toBe('did:sns:alice.attestto.sol#key-1')

    // write BEFORE mirror, both called (dual-vault order)
    expect(order).toEqual(['write', 'syncPublic'])
  })

  it('POSITIVE CONTROL — public-key strip: response pubkey never carries `d`', async () => {
    const { ctx } = makeCtx(makeVault()) // fixture private key HAS `d: OLD_SECRET`
    const result = await handleDidSync(makePayload(), ctx)
    expect(result.publicKeyJwk).not.toBeNull()
    expect('d' in result.publicKeyJwk!).toBe(false)
    expect(JSON.stringify(result.publicKeyJwk)).not.toContain('OLD_SECRET')
  })

  it('POSITIVE CONTROL — keys-never-mirrored: the mirrored vault carries no private key', async () => {
    const { ctx, mirrors } = makeCtx(makeVault())
    await handleDidSync(makePayload(), ctx)
    const mirror = mirrors[0]
    // the real toPublicVault projection the handler routed through
    expect(JSON.stringify(mirror)).not.toContain('OLD_SECRET')
    expect('privateKeyJwk' in mirror).toBe(false)
  })

  it('vault locked (read → null): returns the error response, NO write, NO mirror, NO keygen', async () => {
    const { ctx, order, writes, keygen } = makeCtx(null)

    const result = await handleDidSync(makePayload(), ctx)

    expect(result).toEqual({
      requestId: 'req-1',
      publicKeyJwk: null,
      holderDid: null,
      error: 'Vault is locked',
    })
    expect(ctx.store.write).not.toHaveBeenCalled()
    expect(ctx.store.syncPublic).not.toHaveBeenCalled()
    expect(keygen).not.toHaveBeenCalled()
    expect(order).toEqual([])
    expect(writes).toEqual([])
  })

  it('key ABSENT + did ABSENT: generates keypair AND sets fallback did:jwk', async () => {
    const vault = makeVault({ privateKeyJwk: null, did: null })
    const { ctx, writes, keygen } = makeCtx(vault)

    const result = await handleDidSync(makePayload(), ctx)

    expect(keygen).toHaveBeenCalledOnce()
    const written = writes[0]
    expect(written.privateKeyJwk).toEqual(NEW_PRIV)
    expect(written.did).toBe(publicJwkToDid(NEW_PUB)) // fallback did from the NEW public key
    // response pubkey derived from the new key, still stripped
    expect(result.publicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'NEW_X', y: 'NEW_Y' })
  })

  it('key ABSENT + did PRESENT: generates keypair but does NOT overwrite the existing did (nested guard)', async () => {
    const vault = makeVault({ privateKeyJwk: null, did: 'did:jwk:preexisting' })
    const { ctx, writes, keygen } = makeCtx(vault)

    await handleDidSync(makePayload(), ctx)

    expect(keygen).toHaveBeenCalledOnce()
    expect(writes[0].did).toBe('did:jwk:preexisting') // UNCHANGED — inner `if (!vault.did)` guard
  })

  it('existing identity, payload.tenantId ABSENT: updates vm + syncedAt, does NOT overwrite tenantId', async () => {
    const vault = makeVault({
      linkedIdentities: [
        {
          did: 'did:sns:alice.attestto.sol',
          label: 'alice.attestto.sol',
          verificationMethod: 'old#vm',
          credentials: [],
          syncedAt: '2020-01-01T00:00:00.000Z',
          tenantId: 'tenant-original',
        },
      ],
    })
    const { ctx, writes } = makeCtx(vault)

    await handleDidSync(makePayload({ tenantId: undefined }), ctx)

    const ids = writes[0].linkedIdentities!
    expect(ids).toHaveLength(1) // no new push
    expect(ids[0].verificationMethod).toBe('did:sns:alice.attestto.sol#key-1')
    expect(ids[0].syncedAt).toBe(CLOCK_ISO)
    expect(ids[0].tenantId).toBe('tenant-original') // NOT overwritten (falsy payload.tenantId)
  })

  it('existing identity, payload.tenantId PRESENT: overwrites tenantId', async () => {
    const vault = makeVault({
      linkedIdentities: [
        {
          did: 'did:sns:alice.attestto.sol',
          label: 'alice.attestto.sol',
          verificationMethod: 'old#vm',
          credentials: [],
          syncedAt: '2020-01-01T00:00:00.000Z',
          tenantId: 'tenant-original',
        },
      ],
    })
    const { ctx, writes } = makeCtx(vault)

    await handleDidSync(makePayload({ tenantId: 'tenant-new' }), ctx)

    expect(writes[0].linkedIdentities![0].tenantId).toBe('tenant-new')
  })

  it('new identity, payload.tenantId PRESENT: stored verbatim', async () => {
    const { ctx, writes } = makeCtx(makeVault())
    await handleDidSync(makePayload({ tenantId: 'tenant-x' }), ctx)
    expect(writes[0].linkedIdentities![0].tenantId).toBe('tenant-x')
  })

  it('PARITY (auth is the case, not the handler): runs the full sync regardless of payload.origin', async () => {
    // The handler has no origin/sender parameter — it cannot gate on origin. A
    // hostile origin in the payload does NOT stop the sync; origin authorization
    // is the switch case's job (isPlatformOrigin / isOriginTrusted), unchanged.
    const { ctx } = makeCtx(makeVault())
    const result = await handleDidSync(makePayload({ origin: 'https://evil.example' }), ctx)
    expect(result.error).toBeNull()
    expect(ctx.store.write).toHaveBeenCalledOnce()
  })
})
