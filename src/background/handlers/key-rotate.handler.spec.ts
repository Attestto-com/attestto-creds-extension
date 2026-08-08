/**
 * Story 1.13 Phase 2 — characterization of the extracted KEY_ROTATE core
 * (inversion ii, AD-12): the GOLDEN encodes the OLD inline `handleKeyRotate`
 * behavior, and the extracted handler must pass it UNCHANGED. Parity-to-legacy is
 * the AC — not "handler works." Referents are the injected store/keygen spies +
 * the returned DATA (AD-14: the handler returns data; the case transports it).
 *
 * Preserved legacy behavior (read from bg source before extraction):
 *  - locked vault (read→null)          → error 'Vault is locked', NO write/mirror
 *  - no existing key                   → error 'No existing key to rotate', NO write
 *  - happy: capture OLD pubkey BEFORE overwrite; generate P-256; set did from the
 *    NEW pubkey; write THEN syncPublic (mirror — else hasIdentity/popup read stale)
 */
import { describe, it, expect, vi } from 'vitest'
import { handleKeyRotate } from './key-rotate.handler'
import { publicJwkToDid } from '@/utils/did-jwk'
import type { VaultData } from '@/stores/wallet'

const OLD_PRIV = { kty: 'EC', crv: 'P-256', x: 'OLDX', y: 'OLDY', d: 'OLDD' } as JsonWebKey
const NEW_PRIV = { kty: 'EC', crv: 'P-256', x: 'NEWX', y: 'NEWY', d: 'NEWD' } as JsonWebKey
const NEW_PUB = { kty: 'EC', crv: 'P-256', x: 'NEWX', y: 'NEWY' } as JsonWebKey

function makeCtx(vault: VaultData | null) {
  const order: string[] = []
  const store = {
    read: vi.fn(async () => vault),
    write: vi.fn(async () => { order.push('write') }),
    syncPublic: vi.fn(async () => { order.push('syncPublic') }),
  }
  const keygen = {
    generateP256: vi.fn(async () => { order.push('keygen'); return { privateKeyJwk: NEW_PRIV, publicKeyJwk: NEW_PUB } }),
  }
  return { ctx: { store, keygen }, store, keygen, order }
}

describe('handleKeyRotate — characterization (parity to legacy)', () => {
  it('locked vault → error, and NO write/mirror/keygen', async () => {
    const { ctx, store, keygen } = makeCtx(null)
    const r = await handleKeyRotate(ctx)
    expect(r).toEqual({ newPublicKeyJwk: null, oldPublicKeyJwk: null, error: 'Vault is locked' })
    expect(store.write).not.toHaveBeenCalled()
    expect(store.syncPublic).not.toHaveBeenCalled()
    expect(keygen.generateP256).not.toHaveBeenCalled()
  })

  it('no existing private key → error, and NO write/keygen', async () => {
    const { ctx, store, keygen } = makeCtx({ privateKeyJwk: null } as VaultData)
    const r = await handleKeyRotate(ctx)
    expect(r.error).toBe('No existing key to rotate')
    expect(store.write).not.toHaveBeenCalled()
    expect(keygen.generateP256).not.toHaveBeenCalled()
  })

  it('happy: captures OLD pubkey before overwrite, rotates, mirrors, returns both keys', async () => {
    const vault = { privateKeyJwk: OLD_PRIV, did: 'did:jwk:OLD' } as VaultData
    const { ctx, store, order } = makeCtx(vault)
    const r = await handleKeyRotate(ctx)

    // OLD pubkey = the pre-rotation key material (x/y from OLD), captured before overwrite
    expect(r.oldPublicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'OLDX', y: 'OLDY' })
    // NEW pubkey = only the public fields of the generated key (no `d`)
    expect(r.newPublicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'NEWX', y: 'NEWY' })
    expect(r.error).toBeNull()
    // vault mutated: new private key + did derived from the NEW public key (referent
    // = the real publicJwkToDid, and it must have CHANGED from the pre-rotation did)
    expect(vault.privateKeyJwk).toBe(NEW_PRIV)
    expect(vault.did).toBe(publicJwkToDid(NEW_PUB))
    expect(vault.did).not.toBe('did:jwk:OLD')
    // write THEN syncPublic (mirror after write — order is load-bearing)
    expect(store.write).toHaveBeenCalledOnce()
    expect(store.syncPublic).toHaveBeenCalledOnce()
    expect(order).toEqual(['keygen', 'write', 'syncPublic'])
  })
})
