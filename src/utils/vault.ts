/**
 * Shared vault read/write utilities.
 *
 * Centralizes encrypted vault I/O so that wallet.ts, credentials.ts,
 * and any future store can share the same persistence layer.
 */

import type { VaultData } from '@/stores/wallet'
import { encryptVault, decryptVault } from '@/utils/crypto'
import { STORAGE_KEYS } from '@/config/app'

/**
 * Read and decrypt the vault from chrome.storage.local.
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
