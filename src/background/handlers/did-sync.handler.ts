/**
 * Story 1.10 — the `DID_SYNC` handler, extracted from the legacy switch
 * (`background.ts:1035-1104`) as a near-verbatim move. The vault mutation, keypair
 * generation, `linkedIdentities` upsert, dual-vault write+mirror, and the two
 * positive controls (public-key field-strip, keys-never-mirrored) are pinned HERE.
 *
 * Two faithful inversions from the legacy function, both architecture-aligned:
 *  1. Effects go through injected `ctx` ports (`store`/`keygen`/`clock`) instead of
 *     `readVault`/`writeVault`/`syncPublicVault`/`crypto.subtle` module calls — so
 *     the module is pure (no `chrome.*`, no `crypto.subtle` at import) and testable.
 *  2. The handler RETURNS the `DID_SYNC_RESPONSE` payload data (AD-14 — handlers
 *     return data, the caller owns transport) instead of calling `notifyTab`
 *     itself. The switch case maps that data onto the tab via the unchanged
 *     `sendDidSyncResponse` (which keeps the no-tabId drop). The request-scoped
 *     `senderTabId` is transport routing, not a capability — it never enters `ctx`.
 *
 * `publicJwkToDid` and `extractDidLabel` stay plain imports (pure, AD-4).
 *
 * Parity note (AD-9/10 seam): this handler does NO proof-of-control — it blindly
 * trusts `payload.verificationMethod`, matching the legacy. The route declares a
 * `verifyPeer: { check: 'vmBinding' }` slot (proof-of-control filled in Epic 2,
 * the same missing control as counterparty validation). Origin authorization is
 * NOT the handler's job either — it stays in the switch case (dynamic
 * `isOriginTrusted`, which a static `allowFrom` cannot express); the handler has
 * no `origin`/`sender` parameter, so it cannot check origin by construction.
 */
import { publicJwkToDid } from '@/utils/did-jwk'
import { extractDidLabel } from '@/utils/did-label'
import type { DidSyncMessage } from '@/utils/messaging'
import type { KeyAdminCtx } from '@/background/ctx/ctx-bundles'

/** The `DID_SYNC_RESPONSE` payload the caller sends to the originating tab. */
export interface DidSyncResponseData {
  requestId: string
  publicKeyJwk: JsonWebKey | null
  holderDid: string | null
  error: string | null
}

export async function handleDidSync(
  payload: DidSyncMessage['payload'],
  ctx: Pick<KeyAdminCtx, 'store' | 'keygen' | 'clock'>,
): Promise<DidSyncResponseData> {
  const vault = await ctx.store.read()
  if (!vault) {
    return { requestId: payload.requestId, publicKeyJwk: null, holderDid: null, error: 'Vault is locked' }
  }

  // Generate keypair if none exists.
  if (!vault.privateKeyJwk) {
    const { privateKeyJwk, publicKeyJwk } = await ctx.keygen.generateP256()
    vault.privateKeyJwk = privateKeyJwk

    // Also set the self-issued did:jwk as fallback DID if none set.
    if (!vault.did) {
      vault.did = publicJwkToDid(publicKeyJwk)
    }
  }

  // Extract public key from private JWK (strip private fields — never `d`).
  const publicKeyJwk: JsonWebKey = {
    kty: vault.privateKeyJwk.kty,
    crv: vault.privateKeyJwk.crv,
    x: vault.privateKeyJwk.x,
    y: vault.privateKeyJwk.y,
  }

  // Root `holderDid`/`verificationMethod` are still LIVE, not back-compat: the
  // SIGN_DOCUMENT / PAYMENT / SIGN_ATTESTTO_PDF flows read `vault.holderDid` as a
  // fallback signer and `identity-presence` reads it for `hasIdentity()`. (There
  // are no existing users, so this is not data migration — it is code coupling.)
  // Retiring them in favour of `linkedIdentities[]` is a separate refactor across
  // those ~5 readers, out of scope for this faithful extraction.
  vault.holderDid = payload.holderDid
  vault.verificationMethod = payload.verificationMethod

  // Upsert into linkedIdentities[].
  if (!vault.linkedIdentities) vault.linkedIdentities = []

  const existingIdx = vault.linkedIdentities.findIndex((id) => id.did === payload.holderDid)
  const label = extractDidLabel(payload.holderDid)
  const now = new Date(ctx.clock.now()).toISOString()

  if (existingIdx >= 0) {
    vault.linkedIdentities[existingIdx].verificationMethod = payload.verificationMethod
    vault.linkedIdentities[existingIdx].syncedAt = now
    if (payload.tenantId) {
      vault.linkedIdentities[existingIdx].tenantId = payload.tenantId
    }
  } else {
    vault.linkedIdentities.push({
      did: payload.holderDid,
      label,
      verificationMethod: payload.verificationMethod,
      credentials: [],
      syncedAt: now,
      tenantId: payload.tenantId ?? null,
    })
  }

  await ctx.store.write(vault)
  await ctx.store.syncPublic(vault)

  return { requestId: payload.requestId, publicKeyJwk, holderDid: payload.holderDid, error: null }
}
