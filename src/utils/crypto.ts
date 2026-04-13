/**
 * AES-256-GCM encryption utilities for the extension vault.
 *
 * - At rest: encrypted string in `chrome.storage.local`
 * - In use: base64 key in `chrome.storage.session` (RAM-only, cleared on browser close)
 * - Never exposed to content scripts
 */

const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256
const IV_LENGTH = 12

/**
 * Generate a new AES-256-GCM key and return it as a base64 string.
 */
export async function generateEncryptionKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  )
  const raw = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
}

/**
 * Import a base64 key string into a CryptoKey.
 */
async function importKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, ALGORITHM, false, ['encrypt', 'decrypt'])
}

/**
 * Encrypt an object to a base64 string (IV prepended).
 */
export async function encryptVault(data: unknown, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const plaintext = new TextEncoder().encode(JSON.stringify(data))

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    plaintext,
  )

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)

  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt a base64 string (IV prepended) back to the original object.
 */
export async function decryptVault<T = unknown>(
  base64: string,
  keyBase64: string,
): Promise<T> {
  const key = await importKey(keyBase64)
  const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext,
  )

  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
