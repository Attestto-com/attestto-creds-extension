/**
 * Story 1.13 Phase 2 — the extracted KEY_ROTATE core (KeyAdmin tier, AD-3). Near-
 * verbatim move of the legacy inline `handleKeyRotate` (parity IS the AC, inversion
 * ii). Effects go through injected ports (`store` = read/write/mirror, `keygen` =
 * P-256 generation); the handler returns DATA (AD-14) — the case owns transport
 * (`sendKeyRotateResponse` to the tab) + the `isExtensionSender` gate.
 *
 * `publicJwkToDid` is a pure import (AD-4). The OLD public key is captured BEFORE
 * the overwrite; `store.write` runs THEN `store.syncPublic` (mirror the rotated
 * did:jwk, or `hasIdentity()`/the popup read a stale did — the dual-vault rule).
 */
import type { KeyAdminCtx } from '@/background/ctx/ctx-bundles'
import { publicJwkToDid } from '@/utils/did-jwk'

export interface KeyRotateResult {
  newPublicKeyJwk: JsonWebKey | null
  oldPublicKeyJwk: JsonWebKey | null
  error: string | null
}

const fail = (error: string): KeyRotateResult => ({ newPublicKeyJwk: null, oldPublicKeyJwk: null, error })

export async function handleKeyRotate(ctx: Pick<KeyAdminCtx, 'store' | 'keygen'>): Promise<KeyRotateResult> {
  const vault = await ctx.store.read()
  if (!vault) return fail('Vault is locked')
  if (!vault.privateKeyJwk) return fail('No existing key to rotate')

  // Capture the OLD public key before overwriting the private key.
  const oldPublicKeyJwk: JsonWebKey = {
    kty: vault.privateKeyJwk.kty,
    crv: vault.privateKeyJwk.crv,
    x: vault.privateKeyJwk.x,
    y: vault.privateKeyJwk.y,
  }

  const { privateKeyJwk, publicKeyJwk } = await ctx.keygen.generateP256()
  vault.privateKeyJwk = privateKeyJwk
  vault.did = publicJwkToDid(publicKeyJwk)

  await ctx.store.write(vault)
  await ctx.store.syncPublic(vault) // mirror the rotated did:jwk into the public vault

  const newPublicKeyJwk: JsonWebKey = {
    kty: publicKeyJwk.kty,
    crv: publicKeyJwk.crv,
    x: publicKeyJwk.x,
    y: publicKeyJwk.y,
  }
  return { newPublicKeyJwk, oldPublicKeyJwk, error: null }
}
