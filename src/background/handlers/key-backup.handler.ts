/**
 * The `KEY_BACKUP` handler, extracted from the legacy switch
 * (`background.ts` `handleKeyBackup`, ~1123-1155) as a near-verbatim move.
 *
 * Faithful, architecture-aligned inversions from the legacy function:
 *  1. The single effect (vault READ) goes through the injected `store` port
 *     (`KeyAdminCtx.store`, narrowed to `Pick<KeyVaultStore, 'read'>`) instead of the
 *     `readVault()` module call — so the module is pure (no `chrome.*` at import) and
 *     the read is a spyable seam. This is READ-ONLY by construction: the ctx names no
 *     `write`/`syncPublic` — backup never mutates the vault.
 *  2. The handler RETURNS the shares payload data (AD-14 — handlers return data,
 *     the caller owns transport) instead of calling `sendKeyBackupResponse`. The
 *     switch case maps this data (plus the request-scoped `requestId`, which is
 *     transport routing, not a capability) onto the tab via the unchanged responder.
 *
 * `split2of3` and `toBase64Url` stay plain imports (pure, AD-4 — never ports).
 *
 * SHA-256 is a keyless hash = effectively pure; it is computed with
 * `crypto.subtle.digest` directly here (works in the Vitest node env, not mocked).
 */
import { split2of3, toBase64Url } from '@/services/shamir'
import type { KeyVaultStore } from '@/background/ports/ports'

/** One Shamir share plus its 1-based GF(256) evaluation index. */
export interface KeyBackupShare {
  data: string
  index: number
}

/** The shares payload the caller sends back to the originating tab. */
export interface KeyBackupShares {
  deviceShare: KeyBackupShare
  cloudShare: KeyBackupShare
  guardianShare: KeyBackupShare
  keyHash: string
}

/** Return contract (AD-14): data only — `shares` XOR `error`. */
export interface KeyBackupResult {
  shares: KeyBackupShares | null
  error: string | null
}

export async function handleKeyBackup(
  ctx: { store: Pick<KeyVaultStore, 'read'> },
): Promise<KeyBackupResult> {
  const vault = await ctx.store.read()
  if (!vault) {
    return { shares: null, error: 'Vault is locked' }
  }

  if (!vault.privateKeyJwk) {
    return { shares: null, error: 'No private key to back up' }
  }

  // Serialize the private key JWK to bytes.
  const keyBytes = new TextEncoder().encode(JSON.stringify(vault.privateKeyJwk))

  // Split into 2-of-3 Shamir shares.
  const [share1, share2, share3] = split2of3(keyBytes)

  // Hash of the original key for verification after reconstruction.
  const keyHash = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes)))

  return {
    shares: {
      deviceShare: { data: toBase64Url(share1), index: 1 },
      cloudShare: { data: toBase64Url(share2), index: 2 },
      guardianShare: { data: toBase64Url(share3), index: 3 },
      keyHash,
    },
    error: null,
  }
}
