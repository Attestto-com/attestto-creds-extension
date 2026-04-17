/**
 * WebAuthn PRF utilities for passkey-based vault encryption.
 *
 * Uses the PRF extension (hmac-secret) to derive a deterministic secret
 * from a WebAuthn credential, then derives an AES-256-GCM key via HKDF.
 *
 * Flow:
 *   1. Setup: WebAuthn create() with PRF → credential ID + PRF secret
 *   2. PRF secret → HKDF → 256-bit AES-GCM key
 *   3. Vault encrypted with that AES key
 *   4. Only encrypted vault + credential ID + PRF salt stored at rest
 *   5. Unlock: WebAuthn get() with same PRF salt → same secret → same key
 */

import { STORAGE_KEYS } from '@/config/app'

// ── Encoding Helpers ────────────────────────────────────

function toBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

// ── PRF Extension Types ─────────────────────────────────

interface PrfValues {
  first: ArrayBuffer
}

interface AuthExtensionsOutput {
  prf?: { results?: PrfValues }
}

// ── HKDF Key Derivation ─────────────────────────────────

const HKDF_INFO = new TextEncoder().encode('attestto-id-vault-key')

/**
 * Derive a 256-bit AES-GCM key from a PRF secret using HKDF-SHA256.
 */
async function deriveAesKey(prfSecret: ArrayBuffer, salt: ArrayBuffer): Promise<string> {
  // Import PRF output as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    prfSecret,
    'HKDF',
    false,
    ['deriveKey'],
  )

  // Derive AES-256-GCM key
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info: HKDF_INFO,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )

  // Export as base64 for vault crypto utils
  const raw = await crypto.subtle.exportKey('raw', aesKey)
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
}

// ── WebAuthn Setup (first time) ─────────────────────────

/**
 * Register a new passkey with PRF extension support.
 * Returns the derived AES key (base64) for vault encryption.
 *
 * Stores credential ID and PRF salt in chrome.storage.local.
 */
export async function setupPasskey(): Promise<string> {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32))

  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Attestto ID' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'attestto-id-vault',
        displayName: 'Attestto ID',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
      },
      extensions: {
        // @ts-expect-error PRF extension not yet in TypeScript WebAuthn types
        prf: { eval: { first: prfSalt } },
      },
    },
  }) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Passkey registration cancelled')
  }

  const response = credential.response as AuthenticatorAttestationResponse
  const extensions = (credential.getClientExtensionResults?.() ?? {}) as AuthExtensionsOutput

  // Check PRF support
  const prfResult = extensions.prf?.results?.first
  let aesKeyBase64: string

  if (prfResult) {
    // PRF supported — derive key from PRF output
    aesKeyBase64 = await deriveAesKey(prfResult, prfSalt.buffer)
  } else {
    // PRF not supported — fall back to random key stored in session
    // This is less secure but allows the extension to work on older authenticators
    const fallbackKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const raw = await crypto.subtle.exportKey('raw', fallbackKey)
    aesKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)))
  }

  // Persist credential ID and salt
  await chrome.storage.local.set({
    [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: toBase64Url(credential.rawId),
    [STORAGE_KEYS.PRF_SALT]: toBase64Url(prfSalt.buffer),
  })

  // Cache the derived key in session storage (cleared on browser close)
  await chrome.storage.session.set({
    [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
  })

  return aesKeyBase64
}

// ── WebAuthn Unlock (returning user) ────────────────────

/**
 * Unlock the vault using an existing passkey.
 * Returns the derived AES key (base64) for vault decryption.
 */
export async function unlockWithPasskey(): Promise<string> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID,
    STORAGE_KEYS.PRF_SALT,
  ])

  const credIdBase64 = stored[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID] as string | undefined
  const saltBase64 = stored[STORAGE_KEYS.PRF_SALT] as string | undefined

  if (!credIdBase64 || !saltBase64) {
    throw new Error('No passkey registered — setup required')
  }

  const credentialId = fromBase64Url(credIdBase64)
  const prfSalt = fromBase64Url(saltBase64)

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{
        id: credentialId,
        type: 'public-key',
        transports: ['internal'],
      }],
      userVerification: 'required',
      extensions: {
        // @ts-expect-error PRF extension not yet in TypeScript WebAuthn types
        prf: { eval: { first: new Uint8Array(prfSalt) } },
      },
    },
  }) as PublicKeyCredential | null

  if (!assertion) {
    throw new Error('Passkey authentication cancelled')
  }

  const extensions = (assertion.getClientExtensionResults?.() ?? {}) as AuthExtensionsOutput
  const prfResult = extensions.prf?.results?.first

  let aesKeyBase64: string

  if (prfResult) {
    // Derive the same AES key from PRF output
    aesKeyBase64 = await deriveAesKey(prfResult, prfSalt)
  } else {
    // PRF not available — check if we have a fallback session key
    const session = await chrome.storage.session.get(STORAGE_KEYS.SESSION_KEY)
    const sessionKey = session[STORAGE_KEYS.SESSION_KEY] as string | undefined
    if (sessionKey) {
      aesKeyBase64 = sessionKey
    } else {
      throw new Error('PRF not supported and no session key — vault cannot be unlocked')
    }
  }

  // Cache in session storage
  await chrome.storage.session.set({
    [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
  })

  return aesKeyBase64
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Check if a passkey has been registered for this extension.
 */
export async function hasPasskey(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID)
  return !!stored[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]
}
