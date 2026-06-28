/**
 * Passphrase-based vault key derivation (Argon2id).
 *
 * Used when the user's authenticator does NOT support the WebAuthn PRF
 * extension (notably iCloud Passkeys on Brave/Safari macOS). The passphrase
 * is run through Argon2id with a per-vault salt to deterministically
 * reconstruct the AES-256-GCM key that decrypts the vault.
 *
 * Determinism is the whole point: same passphrase + same salt → same key,
 * forever. Lose the passphrase and the vault is gone (this is by design;
 * Shamir 2-of-3 backup is the user's escape hatch).
 *
 * Parameters follow OWASP 2024 recommendations for interactive use:
 *   m = 19 MiB, t = 2, p = 1 — ~100–300 ms on modern hardware.
 */

import { argon2id } from '@noble/hashes/argon2'
import { STORAGE_KEYS } from '@/config/app'

const ARGON2_PARAMS = {
  t: 2,        // iterations
  m: 19_456,   // 19 MiB memory cost
  p: 1,        // parallelism
  dkLen: 32,   // output: 32 bytes = 256-bit AES key
} as const

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function toStandardBase64(bytes: Uint8Array): string {
  // Vault encryption util consumes standard base64 (not base64url) for the AES key.
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Derive a 256-bit AES-GCM key from a passphrase + salt.
 * Returns the key as standard base64 (matches the format vault crypto expects).
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<string> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters')
  }
  const passBytes = new TextEncoder().encode(passphrase.normalize('NFKC'))
  const derived = argon2id(passBytes, salt, ARGON2_PARAMS)
  return toStandardBase64(derived)
}

/**
 * Generate a fresh 32-byte salt and persist it to chrome.storage.local.
 * Called once at setup time when the user opts for passphrase-based KDF.
 */
export async function generateAndStoreSalt(): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  await chrome.storage.local.set({
    [STORAGE_KEYS.PASSPHRASE_SALT]: toBase64Url(salt),
  })
  return salt
}

/**
 * Read the persisted Argon2id salt. Throws if no salt has been stored
 * (which means setup didn't complete or PRF was used instead).
 */
export async function readSalt(): Promise<Uint8Array> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PASSPHRASE_SALT)
  const saltBase64 = stored[STORAGE_KEYS.PASSPHRASE_SALT] as string | undefined
  if (!saltBase64) {
    throw new Error('No passphrase salt found — vault was not set up with a passphrase')
  }
  return fromBase64Url(saltBase64)
}
