/**
 * Portable vault backup & self-custody recovery.
 *
 * The on-device vault key is device-bound (passkey PRF) or derived from the
 * device passphrase, so it can't move to another machine. A backup therefore
 * re-encrypts the vault contents into a self-contained file that a fresh device
 * can open with ONE of two self-custody recovery methods:
 *
 *   1. `passphrase`   — the file is encrypted with Argon2id(passphrase, salt).
 *                       Restore by re-entering that passphrase.
 *   2. `shamir-2of3`  — the file is encrypted with a random key that is split
 *                       into 3 shares (any 2 reconstruct). The user stashes the
 *                       shares in 3 places; the file alone is useless. Restore
 *                       by supplying any 2 shares.
 *
 * No guardian DIDs, no network, no platform share — everything here is
 * self-custody and works fully offline. Social/guardian recovery (encrypting a
 * share to a guardian's DID + a DIDComm return handshake) is a separate,
 * heavier layer that belongs on the desktop app, not the extension.
 */

import type { VaultData } from '@/stores/wallet'
import { encryptVault, decryptVault, generateEncryptionKey } from '@/utils/crypto'
import { deriveKeyFromPassphrase } from '@/utils/passphrase-kdf'
import { split2of3, combine2of3, toBase64Url, fromBase64Url } from '@/services/shamir'

/** Discriminates how the backup file's contents can be recovered. */
export type BackupMethod = 'passphrase' | 'shamir-2of3'

/** Marker string identifying an Attestto vault backup file. */
export const BACKUP_FORMAT = 'attestto-vault-backup' as const

/** Serialized backup file (what gets written to disk). */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: 1
  createdAt: string
  method: BackupMethod
  cipher: 'AES-256-GCM'
  /** Argon2id parameters — present only for the `passphrase` method. */
  kdf?: { name: 'argon2id'; salt: string }
  /** encryptVault() output: base64, IV-prepended ciphertext of the VaultData. */
  payload: string
}

/** A single Shamir share as handed to the user: "<index>.<base64url(bytes)>". */
export type ShareString = string

/**
 * Export a passphrase-protected backup.
 *
 * @param vault      Decrypted vault contents (caller must be unlocked).
 * @param passphrase Backup passphrase (min 8 chars, enforced by the KDF).
 * @param now        Timestamp injector (defaults to wall clock).
 * @returns Pretty-printed JSON to save as a `.attestto-backup` file.
 */
export async function exportPassphraseBackup(
  vault: VaultData,
  passphrase: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const key = await deriveKeyFromPassphrase(passphrase, salt)
  const payload = await encryptVault(vault, key)

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now().toISOString(),
    method: 'passphrase',
    cipher: 'AES-256-GCM',
    kdf: { name: 'argon2id', salt: toBase64Url(salt) },
    payload,
  }
  return JSON.stringify(file, null, 2)
}

/**
 * Restore a passphrase backup. Throws on a wrong passphrase (GCM auth failure)
 * or a malformed / non-matching file.
 */
export async function importPassphraseBackup(
  fileText: string,
  passphrase: string,
): Promise<VaultData> {
  const file = parseBackupFile(fileText, 'passphrase')
  if (!file.kdf?.salt) throw new Error('Backup is missing its key-derivation salt')

  const salt = fromBase64Url(file.kdf.salt)
  const key = await deriveKeyFromPassphrase(passphrase, salt)
  try {
    return await decryptVault<VaultData>(file.payload, key)
  } catch {
    throw new Error('Could not decrypt — wrong passphrase or corrupted backup')
  }
}

/**
 * Export a Shamir-protected backup.
 *
 * @returns `file` (save to disk) and `shares` (3 strings — the user stores each
 *          in a DIFFERENT place; any 2 restore, the file alone cannot).
 */
export async function exportShamirBackup(
  vault: VaultData,
  now: () => Date = () => new Date(),
): Promise<{ file: string; shares: [ShareString, ShareString, ShareString] }> {
  const cekBase64 = await generateEncryptionKey()
  const payload = await encryptVault(vault, cekBase64)

  const secret = Uint8Array.from(atob(cekBase64), (c) => c.charCodeAt(0))
  const [s1, s2, s3] = split2of3(secret)

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now().toISOString(),
    method: 'shamir-2of3',
    cipher: 'AES-256-GCM',
    payload,
  }
  return {
    file: JSON.stringify(file, null, 2),
    shares: [encodeShare(1, s1), encodeShare(2, s2), encodeShare(3, s3)],
  }
}

/**
 * Restore a Shamir backup from the file plus any 2 of the 3 shares. Throws on
 * duplicate/invalid shares, a wrong pair (GCM auth failure), or a bad file.
 */
export async function importShamirBackup(
  fileText: string,
  shareA: ShareString,
  shareB: ShareString,
): Promise<VaultData> {
  const file = parseBackupFile(fileText, 'shamir-2of3')

  const a = decodeShare(shareA)
  const b = decodeShare(shareB)
  const secret = combine2of3(a, b) // throws on identical/out-of-range indices

  const cekBase64 = btoa(String.fromCharCode(...secret))
  try {
    return await decryptVault<VaultData>(file.payload, cekBase64)
  } catch {
    throw new Error('Could not decrypt — those shares do not match this backup')
  }
}

/** Peek at a backup file to decide which recovery inputs to ask the user for. */
export function detectBackupMethod(fileText: string): BackupMethod {
  return parseBackupFile(fileText).method
}

// ── internals ────────────────────────────────────────────────────────────────

function parseBackupFile(fileText: string, expectMethod?: BackupMethod): BackupFile {
  let file: BackupFile
  try {
    file = JSON.parse(fileText) as BackupFile
  } catch {
    throw new Error('Not a valid backup file (invalid JSON)')
  }
  if (file?.format !== BACKUP_FORMAT) {
    throw new Error('Not an Attestto vault backup file')
  }
  if (file.method !== 'passphrase' && file.method !== 'shamir-2of3') {
    throw new Error(`Unsupported backup method: ${String((file).method)}`)
  }
  if (typeof file.payload !== 'string' || !file.payload) {
    throw new Error('Backup file is missing its encrypted payload')
  }
  if (expectMethod && file.method !== expectMethod) {
    throw new Error(`This backup uses "${file.method}", not "${expectMethod}"`)
  }
  return file
}

function encodeShare(index: number, data: Uint8Array): ShareString {
  return `${index}.${toBase64Url(data)}`
}

function decodeShare(share: ShareString): { data: Uint8Array; index: number } {
  const dot = share.indexOf('.')
  if (dot < 1) throw new Error('Malformed recovery share')
  const index = Number.parseInt(share.slice(0, dot), 10)
  if (!Number.isInteger(index) || index < 1 || index > 3) {
    throw new Error('Recovery share has an invalid index')
  }
  const data = fromBase64Url(share.slice(dot + 1).trim())
  if (data.length === 0) throw new Error('Recovery share has no data')
  return { data, index }
}
