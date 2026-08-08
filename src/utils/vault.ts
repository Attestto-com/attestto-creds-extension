/**
 * Shared vault read/write utilities.
 *
 * Two storage layers:
 *   PUBLIC  — unencrypted chrome.storage.local. Credentials, DIDs, identities.
 *             Always readable without passkey. No private keys here.
 *   PRIVATE — AES-encrypted chrome.storage.local. Contains only the signing
 *             private key (privateKeyJwk). Requires passkey PRF to decrypt.
 */

import type { VaultData } from '@/stores/wallet'
import { encryptVault, decryptVault } from '@/utils/crypto'
import { STORAGE_KEYS } from '@/config/app'
import type { StoredCredential, StoredKeyShare, ProofAccessRequest, PreparedPresentation } from '@/types/credential'
import type { LinkedIdentity } from '@/stores/wallet'

/**
 * Public vault data — always readable, no encryption.
 * Contains everything EXCEPT the private signing key.
 */
export interface PublicVaultData {
  did: string | null
  credentials: StoredCredential[]
  linkedSolanaAddress: string | null
  keyShares: StoredKeyShare[]
  proofRequests: ProofAccessRequest[]
  preparedPresentations: PreparedPresentation[]
  verificationMethod?: string
  holderDid?: string | null
  linkedIdentities?: LinkedIdentity[]
  /** Public mirror of pairwise per-site DIDs (no keys): origin → { did, createdAt, lastUsedAt }. */
  siteDids?: Record<string, { did: string; createdAt: string; lastUsedAt: string }>
}

// ── Public vault (always readable) ──────────────────────────

/**
 * Read public vault data. No passkey needed.
 */
export async function readPublicVault(): Promise<PublicVaultData | null> {
  const local = await chrome.storage.local.get(STORAGE_KEYS.PUBLIC_VAULT)
  const data = local[STORAGE_KEYS.PUBLIC_VAULT] as PublicVaultData | undefined
  return data ?? null
}

/**
 * Write public vault data. No passkey needed.
 */
export async function writePublicVault(data: PublicVaultData): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PUBLIC_VAULT]: data })
}

// ── Private vault (encrypted, passkey required) ─────────────

/**
 * Read and decrypt the private vault (signing key only).
 * Returns null if no vault or session key exists.
 */
export async function readVault(): Promise<VaultData | null> {
  const local = await chrome.storage.local.get(STORAGE_KEYS.VAULT)
  const session = await chrome.storage.session.get(STORAGE_KEYS.SESSION_KEY)

  const encrypted = local[STORAGE_KEYS.VAULT] as string | undefined
  const keyBase64 = session[STORAGE_KEYS.SESSION_KEY] as string | undefined

  if (!encrypted || !keyBase64) return null

  return decryptVault<VaultData>(encrypted, keyBase64)
}

/**
 * Encrypt and write the vault to chrome.storage.local.
 * Requires an active session key in chrome.storage.session.
 */
export async function writeVault(data: VaultData): Promise<void> {
  const session = await chrome.storage.session.get(STORAGE_KEYS.SESSION_KEY)
  const keyBase64 = session[STORAGE_KEYS.SESSION_KEY] as string | undefined

  if (!keyBase64) {
    throw new Error('No session key — vault is locked')
  }

  const encrypted = await encryptVault(data, keyBase64)
  await chrome.storage.local.set({ [STORAGE_KEYS.VAULT]: encrypted })
}

// ── Public projection (Story 1.7 — allowlist, not denylist; SM2 zero PII) ─────

/**
 * The EXACT key set a public credential carries. `raw` and `decodedClaims` are
 * present but NEUTRALIZED (`''` / `{}`) so the popup's `CredentialCard` degrades
 * to metadata without a code change, while carrying zero decoded PII at rest.
 * Object.keys of a projected credential must equal this set — a new StoredCredential
 * field cannot appear here (construct-only ⇒ defaults private, FR1).
 */
export const PUBLIC_CREDENTIAL_KEYS = [
  'id',
  'format',
  'raw',
  'issuer',
  'issuedAt',
  'expiresAt',
  'types',
  'decodedClaims',
  'metadata',
] as const

/**
 * Project a stored credential to its public, PII-free form. **Construct-only —
 * never `...spread`**: a spread is exactly how the next decoded-PII field would
 * silently ride into the plaintext mirror. `decodedClaims` (cédula/DOB/name) and
 * `raw` (the SD-JWT/VC token, which carries the disclosures) are dropped to
 * empty; only non-PII card metadata survives. Applied to root credentials AND
 * every `linkedIdentities[].credentials` (the nested path is the easy miss).
 */
export function toPublicCredential(c: StoredCredential): StoredCredential {
  return {
    id: c.id,
    format: c.format,
    raw: '', // token dropped — decoded/present only in the encrypted vault
    issuer: c.issuer,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    types: c.types,
    decodedClaims: {}, // decoded PII stays encrypted; card shows claims post-unlock
    // Only display metadata; disclosureDigests (SD-JWT hashes) are not mirrored.
    metadata: { addedAt: c.metadata.addedAt, source: c.metadata.source },
  }
}

/**
 * The single allowlist source of truth: build the public mirror from full vault
 * data. Top-level fields are enumerated (construct-only, so a newly-added
 * VaultData field defaults to private); private keys are never named here;
 * credentials — root and nested — pass through {@link toPublicCredential}.
 */
export function toPublicVault(vault: VaultData): PublicVaultData {
  return {
    did: vault.did,
    credentials: vault.credentials.map(toPublicCredential),
    linkedSolanaAddress: vault.linkedSolanaAddress,
    keyShares: vault.keyShares,
    proofRequests: vault.proofRequests,
    preparedPresentations: vault.preparedPresentations,
    verificationMethod: vault.verificationMethod,
    holderDid: vault.holderDid,
    linkedIdentities: vault.linkedIdentities?.map((identity) => ({
      did: identity.did,
      label: identity.label,
      verificationMethod: identity.verificationMethod,
      credentials: identity.credentials.map(toPublicCredential),
      syncedAt: identity.syncedAt,
      tenantId: identity.tenantId,
    })),
    // Public mirror carries only origin → did — the private keys stay encrypted.
    siteDids: vault.siteDids
      ? Object.fromEntries(
          Object.entries(vault.siteDids).map(([origin, entry]) => [
            origin,
            { did: entry.did, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt },
          ]),
        )
      : undefined,
  }
}

/**
 * Sync public vault from full vault data. Call after any vault write to keep
 * public data in sync. The PII-free projection is {@link toPublicVault}.
 */
export async function syncPublicVault(vault: VaultData): Promise<void> {
  await writePublicVault(toPublicVault(vault))
}
