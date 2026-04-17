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

/**
 * Sync public vault from full vault data.
 * Call after any vault write to keep public data in sync.
 */
export async function syncPublicVault(vault: VaultData): Promise<void> {
  const pub: PublicVaultData = {
    did: vault.did,
    credentials: vault.credentials,
    linkedSolanaAddress: vault.linkedSolanaAddress,
    keyShares: vault.keyShares,
    proofRequests: vault.proofRequests,
    preparedPresentations: vault.preparedPresentations,
    verificationMethod: vault.verificationMethod,
    holderDid: vault.holderDid,
    linkedIdentities: vault.linkedIdentities,
  }
  await writePublicVault(pub)
}
