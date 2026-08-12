/**
 * Characterization of `handleKeyRestore`, transcribed from the legacy inline
 * behavior (`background.ts` `handleKeyRestore`, ~1178-1230) FIRST; the extracted
 * handler passes it unchanged (parity-to-legacy is the AC, not "the handler works").
 *
 * Independent referents per edge (write spy / syncPublic spy / call-order array /
 * the RETURNED result / the REAL `toPublicVault` projection). The round-trip is
 * REAL: a valid P-256 private JWK is serialized, `split2of3` into three shares,
 * two of them base64url-encoded back into the input — so a green here proves the
 * decode → combine → parse → validate → write → mirror chain end to end, not a
 * hand-mocked shortcut.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { handleKeyRestore } from './key-restore.handler'
import { split2of3, toBase64Url } from '@/services/shamir'
import { publicJwkToDid } from '@/utils/did-jwk'
import { toPublicVault } from '@/utils/vault'
import type { VaultData } from '@/stores/wallet'
import type { PublicVaultData } from '@/utils/vault'

/** Encode any JWK to two real 2-of-3 shares (indices 1 & 2) in the input shape. */
function jwkToShares(jwk: JsonWebKey): {
  shareA: { data: string; index: number }
  shareB: { data: string; index: number }
} {
  const bytes = new TextEncoder().encode(JSON.stringify(jwk))
  const [s1, s2] = split2of3(bytes)
  return {
    shareA: { data: toBase64Url(s1), index: 1 },
    shareB: { data: toBase64Url(s2), index: 2 },
  }
}

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:existing',
    privateKeyJwk: null,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    linkedIdentities: [],
    ...overrides,
  }
}

function makeCtx(vault: VaultData | null) {
  const order: string[] = []
  const writes: VaultData[] = []
  const mirrors: PublicVaultData[] = []
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
  }
  return { ctx, order, writes, mirrors }
}

// A real, valid P-256 private JWK generated once via WebCrypto for the round-trip.
let validPrivateJwk: JsonWebKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  validPrivateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
})

describe('handleKeyRestore — characterization (parity-to-legacy)', () => {
  it('valid P-256 shares: reconstructs, writes key + regenerated did, mirrors, returns error null', async () => {
    const vault = makeVault()
    const { ctx, order, writes, mirrors } = makeCtx(vault)
    const { shareA, shareB } = jwkToShares(validPrivateJwk)

    const result = await handleKeyRestore({ shareA, shareB }, ctx)

    expect(result).toEqual({ error: null })

    // wrote the reconstructed private key back
    const written = writes[0]
    expect(written.privateKeyJwk).toEqual(validPrivateJwk)

    // did regenerated from the PUBLIC projection of the restored key
    const expectedDid = publicJwkToDid({
      kty: validPrivateJwk.kty,
      crv: validPrivateJwk.crv,
      x: validPrivateJwk.x,
      y: validPrivateJwk.y,
    })
    expect(written.did).toBe(expectedDid)

    // write BEFORE syncPublic — order load-bearing (dual-vault rule)
    expect(order).toEqual(['write', 'syncPublic'])

    // the mirror carries the public did but never the private key
    const mirror = mirrors[0]
    expect('privateKeyJwk' in mirror).toBe(false)
    expect(JSON.stringify(mirror)).not.toContain(validPrivateJwk.d)
  })

  it('vault locked (read → null): returns error, NO write, NO mirror', async () => {
    const { ctx, order, writes } = makeCtx(null)
    const { shareA, shareB } = jwkToShares(validPrivateJwk)

    const result = await handleKeyRestore({ shareA, shareB }, ctx)

    expect(result).toEqual({ error: 'Vault is locked' })
    expect(ctx.store.write).not.toHaveBeenCalled()
    expect(ctx.store.syncPublic).not.toHaveBeenCalled()
    expect(order).toEqual([])
    expect(writes).toEqual([])
  })

  it('invalid reconstructed key (kty !== EC): rejects with the exact message, NO write, NO mirror', async () => {
    const { ctx, order, writes } = makeCtx(makeVault())
    // Reconstructs to a syntactically valid JWK that is NOT a P-256 private key.
    const { shareA, shareB } = jwkToShares({ kty: 'OKP', crv: 'Ed25519', x: 'X', d: 'SECRET' })

    const result = await handleKeyRestore({ shareA, shareB }, ctx)

    expect(result).toEqual({ error: 'Reconstructed key is not a valid P-256 private key' })
    expect(ctx.store.write).not.toHaveBeenCalled()
    expect(ctx.store.syncPublic).not.toHaveBeenCalled()
    expect(order).toEqual([])
    expect(writes).toEqual([])
  })

  it('invalid reconstructed key (missing `d`, i.e. a PUBLIC key): rejects, NO write', async () => {
    const { ctx, writes } = makeCtx(makeVault())
    const { shareA, shareB } = jwkToShares({ kty: 'EC', crv: 'P-256', x: 'X', y: 'Y' })

    const result = await handleKeyRestore({ shareA, shareB }, ctx)

    expect(result).toEqual({ error: 'Reconstructed key is not a valid P-256 private key' })
    expect(ctx.store.write).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('garbage shares (combine yields non-JSON): catch path returns a message, NO write', async () => {
    const { ctx, writes } = makeCtx(makeVault())
    // Random bytes that will not decode to valid JSON after Lagrange combine.
    const s = { data: toBase64Url(new Uint8Array([1, 2, 3, 4, 5])), index: 1 }
    const t = { data: toBase64Url(new Uint8Array([9, 8, 7, 6, 5])), index: 2 }

    const result = await handleKeyRestore({ shareA: s, shareB: t }, ctx)

    expect(result.error).not.toBeNull()
    expect(ctx.store.write).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})
