/**
 * Characterization of `handleKeyBackup`, transcribed from the legacy switch
 * behavior (`background.ts` `handleKeyBackup`, ~1123-1155) FIRST; the extracted
 * handler passes it unchanged (parity-to-legacy is the AC).
 *
 * The INDEPENDENT REFERENTS are the injected `store.read` spy (drives the two
 * error branches) and the RETURNED data shape. Non-vacuity of the happy path is
 * pinned by an independent referent that the legacy never emits: the three shares
 * ROUND-TRIP through the real `combine2of3` back to the exact serialized key bytes,
 * and the returned `keyHash` equals a hash computed OUTSIDE the handler. A handler
 * that emitted three identical shares, or a constant hash, reddens here.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleKeyBackup } from './key-backup.handler'
import { combine2of3, fromBase64Url } from '@/services/shamir'
import type { VaultData } from '@/stores/wallet'

const PRIV: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'PX', y: 'PY', d: 'PRIVATE_SECRET' }

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:existing',
    privateKeyJwk: PRIV,
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
  const read = vi.fn(async () => vault)
  return { ctx: { store: { read } }, read }
}

describe('handleKeyBackup — characterization (parity-to-legacy)', () => {
  it('vault locked (read → null): returns error, no shares', async () => {
    const { ctx, read } = makeCtx(null)
    const result = await handleKeyBackup(ctx)
    expect(result).toEqual({ shares: null, error: 'Vault is locked' })
    expect(read).toHaveBeenCalledOnce()
  })

  it('no private key: returns the distinct error, no shares', async () => {
    const { ctx } = makeCtx(makeVault({ privateKeyJwk: null }))
    const result = await handleKeyBackup(ctx)
    expect(result).toEqual({ shares: null, error: 'No private key to back up' })
  })

  it('happy path: exact shares shape — indices 1/2/3, keyHash is a base64url string', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleKeyBackup(ctx)

    expect(result.error).toBeNull()
    expect(result.shares).not.toBeNull()
    const s = result.shares!
    expect(s.deviceShare.index).toBe(1)
    expect(s.cloudShare.index).toBe(2)
    expect(s.guardianShare.index).toBe(3)
    // base64url alphabet only, non-empty
    expect(s.keyHash).toMatch(/^[A-Za-z0-9_-]+$/)
    // three DISTINCT, non-empty share strings (a handler emitting one share for all
    // three indices reddens here)
    const datas = [s.deviceShare.data, s.cloudShare.data, s.guardianShare.data]
    for (const d of datas) expect(d.length).toBeGreaterThan(0)
    expect(new Set(datas).size).toBe(3)
  })

  it('shares ROUND-TRIP: any 2 of 3 reconstruct the exact serialized private key', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleKeyBackup(ctx)
    const s = result.shares!

    const expectedBytes = new TextEncoder().encode(JSON.stringify(PRIV))
    const pairs: [KeyPair, KeyPair][] = [
      [{ data: s.deviceShare.data, index: 1 }, { data: s.cloudShare.data, index: 2 }],
      [{ data: s.deviceShare.data, index: 1 }, { data: s.guardianShare.data, index: 3 }],
      [{ data: s.cloudShare.data, index: 2 }, { data: s.guardianShare.data, index: 3 }],
    ]
    for (const [a, b] of pairs) {
      const recovered = combine2of3(
        { data: fromBase64Url(a.data), index: a.index },
        { data: fromBase64Url(b.data), index: b.index },
      )
      expect(Array.from(recovered)).toEqual(Array.from(expectedBytes))
    }
  })

  it('keyHash equals an INDEPENDENT SHA-256 of the serialized key (constant-hash mutation reddens)', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleKeyBackup(ctx)

    const keyBytes = new TextEncoder().encode(JSON.stringify(PRIV))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes))
    const expectedHash = toBase64UrlLocal(digest)
    expect(result.shares!.keyHash).toBe(expectedHash)
  })
})

interface KeyPair {
  data: string
  index: number
}

/** Local base64url encoder — an INDEPENDENT referent, not the handler's import. */
function toBase64UrlLocal(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
