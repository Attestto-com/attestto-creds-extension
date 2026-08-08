/**
 * The `KEY_RESTORE` handler, extracted from the legacy inline `handleKeyRestore`
 * (`background.ts` ~1178-1230) as a near-verbatim move. Two faithful inversions,
 * both architecture-aligned:
 *  1. Effects go through the injected `ctx.store` port (`read`/`write`/`syncPublic`)
 *     instead of `readVault`/`writeVault`/`syncPublicVault` module calls — the
 *     module is pure (no `chrome.*` at import) and testable.
 *  2. The handler RETURNS the result data (AD-14 — handlers return data, the caller
 *     owns transport) instead of calling `sendKeyRestoreResponse`. The switch case
 *     maps `{ error }` onto the tab via the unchanged responder; the request-scoped
 *     `requestId`/`senderTabId` are transport routing, never handler concerns.
 *
 * `combine2of3`/`fromBase64Url` and `publicJwkToDid` stay plain imports (pure, AD-4).
 *
 * Order is load-bearing: `write` THEN `syncPublic` — the public mirror must reflect
 * the restored `did`, or the popup keeps reading an empty did after recovery.
 */
import { combine2of3, fromBase64Url } from '@/services/shamir'
import { publicJwkToDid } from '@/utils/did-jwk'
import type { KeyAdminCtx } from '@/background/ctx/ctx-bundles'

/** The `KEY_RESTORE_RESPONSE` result the caller sends to the originating tab. */
export interface KeyRestoreResult {
  error: string | null
}

/** The two social-recovery shares the handler reconstructs the private key from. */
export interface KeyRestoreInput {
  shareA: { data: string; index: number }
  shareB: { data: string; index: number }
}

export async function handleKeyRestore(
  input: KeyRestoreInput,
  ctx: Pick<KeyAdminCtx, 'store'>,
): Promise<KeyRestoreResult> {
  const vault = await ctx.store.read()
  if (!vault) {
    return { error: 'Vault is locked' }
  }

  try {
    const shareA = {
      data: fromBase64Url(input.shareA.data),
      index: input.shareA.index,
    }
    const shareB = {
      data: fromBase64Url(input.shareB.data),
      index: input.shareB.index,
    }

    // Reconstruct the private key bytes.
    const keyBytes = combine2of3(shareA, shareB)
    const keyJson = new TextDecoder().decode(keyBytes)
    const privateKeyJwk = JSON.parse(keyJson) as JsonWebKey

    // Validate it's a valid P-256 private key (NO write on failure).
    if (privateKeyJwk.kty !== 'EC' || privateKeyJwk.crv !== 'P-256' || !privateKeyJwk.d) {
      return { error: 'Reconstructed key is not a valid P-256 private key' }
    }

    // Write restored key to vault.
    vault.privateKeyJwk = privateKeyJwk

    // Regenerate did:jwk from the restored key.
    const publicJwk: JsonWebKey = {
      kty: privateKeyJwk.kty,
      crv: privateKeyJwk.crv,
      x: privateKeyJwk.x,
      y: privateKeyJwk.y,
    }
    vault.did = publicJwkToDid(publicJwk)

    await ctx.store.write(vault)
    // Mirror the restored did:jwk into the public vault, or hasIdentity()
    // (auth fail-fast) and the popup keep reading an empty did after recovery.
    await ctx.store.syncPublic(vault)
    return { error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Key restoration failed'
    return { error: msg }
  }
}
