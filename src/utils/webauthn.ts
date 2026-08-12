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
import { deriveKeyFromPassphrase, generateAndStoreSalt, readSalt } from './passphrase-kdf'

export type KdfMethod = 'prf' | 'passphrase'

/** Read which KDF method was selected at setup time. */
export async function getKdfMethod(): Promise<KdfMethod | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.KDF_METHOD)
  const method = stored[STORAGE_KEYS.KDF_METHOD] as KdfMethod | undefined
  return method ?? null
}

async function setKdfMethod(method: KdfMethod): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.KDF_METHOD]: method })
}

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
 * Result of probing whether the authenticator supports PRF.
 * Used by the setup view to decide whether to ask for a passphrase.
 */
export interface SetupResult {
  /** AES key (base64) for vault encryption — already cached in session */
  aesKeyBase64: string
  /** Which KDF method was actually used */
  method: KdfMethod
}

/**
 * Ask an ALREADY-REGISTERED credential for a PRF secret.
 *
 * Returns null when the authenticator declines, cancels, or returns no PRF
 * output. Null means "PRF is not available here", which is the only condition
 * under which a passphrase fallback is legitimate.
 */
async function tryPrfAssertion(
  credIdBase64: string,
  prfSaltBase64: string,
): Promise<ArrayBuffer | null> {
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          { id: fromBase64Url(credIdBase64), type: 'public-key', transports: ['internal'] },
        ],
        userVerification: 'required',
        extensions: { prf: { eval: { first: new Uint8Array(fromBase64Url(prfSaltBase64)) } } },
      },
    })) as PublicKeyCredential | null

    if (!assertion) return null
    const ext = (assertion.getClientExtensionResults?.() ?? {}) as AuthExtensionsOutput
    return ext.prf?.results?.first ?? null
  } catch {
    // A declined or unavailable authenticator is not an error here; it is the
    // signal that the passphrase path is needed.
    return null
  }
}

/**
 * Register a new passkey and derive the vault key.
 *
 * If the authenticator supports the WebAuthn PRF extension → use it (HKDF over PRF output).
 * If not → fall back to Argon2id over a user-supplied passphrase (must be provided).
 *
 * @param passphrase  Required ONLY if PRF turns out to be unsupported. Supplying one
 *                    on a PRF-capable device does not downgrade the vault — PRF wins.
 */
export async function setupPasskey(passphrase?: string): Promise<SetupResult> {
  // If a previous setup attempt created a passkey but failed mid-flow (e.g. PRF
  // unsupported AND no passphrase was supplied), the credential ID is already
  // persisted. Reusing it here prevents stacking orphan passkeys in the user's
  // keychain on every retry.
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID,
    STORAGE_KEYS.PRF_SALT,
  ])
  const existingCredId = existing[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID] as string | undefined
  const existingSalt = existing[STORAGE_KEYS.PRF_SALT] as string | undefined

  if (existingCredId) {
    /**
     * A passkey is already in the keychain from a previous attempt. Reuse it
     * rather than minting another — re-registering stacks orphan credentials.
     *
     * 🩸 PASSKEY-FIRST. This branch used to read
     * `if (existingCredId && passphrase)` and go straight to passphrase KDF,
     * on the reasoning that "PRF must have been unsupported, otherwise setup
     * would have completed".
     *
     * That reasoning is wrong. The credential ID is persisted IMMEDIATELY on
     * creation, before PRF support is known, so a first attempt that was
     * cancelled or interrupted for ANY reason leaves one behind. On a
     * PRF-capable device, a retry with a passphrase in the form would then
     * permanently downgrade the vault to passphrase mode, and the passkey —
     * still registered, still prompting the user — would play no part in
     * unlocking it.
     *
     * So: ask the authenticator. A passphrase is a fallback for hardware that
     * cannot do PRF, never a shortcut taken because one was available.
     */
    if (existingSalt) {
      const prfResult = await tryPrfAssertion(existingCredId, existingSalt)
      if (prfResult) {
        const aesKeyBase64 = await deriveAesKey(prfResult, fromBase64Url(existingSalt))
        await setKdfMethod('prf')
        await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64 })
        return { aesKeyBase64, method: 'prf' }
      }
    }

    // PRF genuinely unavailable on this authenticator. Now the passphrase is
    // the only deterministic path, and it must be present.
    if (!passphrase) {
      throw new Error(
        'PRF_REQUIRES_PASSPHRASE: This authenticator does not support WebAuthn PRF. ' +
        'Please set a passphrase to encrypt your vault — it will be required to unlock.',
      )
    }
    const salt = await generateAndStoreSalt()
    const aesKeyBase64 = await deriveKeyFromPassphrase(passphrase, salt)
    await setKdfMethod('passphrase')
    await chrome.storage.session.set({
      [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
    })
    return { aesKeyBase64, method: 'passphrase' }
  }

  const prfSalt = crypto.getRandomValues(new Uint8Array(32))

  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Attestto' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'attestto-id-vault',
        displayName: 'Attestto',
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
        prf: { eval: { first: prfSalt } },
      },
    },
  }) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Passkey registration cancelled')
  }

  // Persist credential ID + PRF salt IMMEDIATELY, before we know whether PRF
  // worked. This guarantees the next retry can reuse this passkey instead of
  // asking the authenticator to mint another one.
  await chrome.storage.local.set({
    [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: toBase64Url(credential.rawId),
    [STORAGE_KEYS.PRF_SALT]: toBase64Url(prfSalt.buffer),
  })

  const extensions = (credential.getClientExtensionResults?.() ?? {}) as AuthExtensionsOutput
  const prfResult = extensions.prf?.results?.first
  let aesKeyBase64: string
  let method: KdfMethod

  if (prfResult) {
    // PRF supported — deterministically derive key from PRF output.
    // Vault is recoverable after any browser restart via passkey re-prompt.
    aesKeyBase64 = await deriveAesKey(prfResult, prfSalt.buffer)
    method = 'prf'
  } else {
    // PRF NOT supported — require passphrase for deterministic recovery.
    if (!passphrase) {
      throw new Error(
        'PRF_REQUIRES_PASSPHRASE: This authenticator does not support WebAuthn PRF. ' +
        'Please set a passphrase to encrypt your vault — it will be required to unlock.',
      )
    }
    const salt = await generateAndStoreSalt()
    aesKeyBase64 = await deriveKeyFromPassphrase(passphrase, salt)
    method = 'passphrase'
  }

  await setKdfMethod(method)

  // Cache the derived key in session storage (cleared on browser close)
  await chrome.storage.session.set({
    [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
  })

  return { aesKeyBase64, method }
}


// ── WebAuthn Unlock (returning user) ────────────────────

/**
 * Unlock the vault. Routes by the KDF method recorded at setup time:
 *   - 'prf'        → WebAuthn assertion + PRF → HKDF-derived AES key
 *   - 'passphrase' → passphrase + Argon2id → AES key
 *
 * The passphrase parameter is REQUIRED if the vault was set up with passphrase KDF.
 * Throws a tagged error (`PASSPHRASE_REQUIRED`) if unlock requires a passphrase but
 * none was supplied — the unlock UI uses that to know to prompt.
 */
export async function unlockWithPasskey(passphrase?: string): Promise<string> {
  const method = (await getKdfMethod()) ?? 'prf' // legacy vaults default to prf

  if (method === 'passphrase') {
    if (!passphrase) {
      throw new Error('PASSPHRASE_REQUIRED: This vault was set up with a passphrase. Enter it to unlock.')
    }
    const salt = await readSalt()
    const aesKeyBase64 = await deriveKeyFromPassphrase(passphrase, salt)
    await chrome.storage.session.set({
      [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
    })
    return aesKeyBase64
  }

  // PRF path
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
        prf: { eval: { first: new Uint8Array(prfSalt) } },
      },
    },
  }) as PublicKeyCredential | null

  if (!assertion) {
    throw new Error('Passkey authentication cancelled')
  }

  const extensions = (assertion.getClientExtensionResults?.() ?? {}) as AuthExtensionsOutput
  const prfResult = extensions.prf?.results?.first

  if (!prfResult) {
    // Vault was supposedly set up with PRF, but this unlock attempt returned none.
    // Most common cause: a legacy vault from before passphrase-recovery shipped.
    // No safe path forward — the vault is unrecoverable. User must reset.
    throw new Error(
      'PRF_UNAVAILABLE: Your authenticator did not return a PRF secret. ' +
      'If this is a legacy vault, it cannot be unlocked and the wallet must be reset.',
    )
  }

  // Derive the same AES key from PRF output
  const aesKeyBase64 = await deriveAesKey(prfResult, prfSalt)

  // Cache in session storage
  await chrome.storage.session.set({
    [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
  })

  return aesKeyBase64
}

// ── Signing gate (ATT-1098) ─────────────────────────────

/**
 * Prove fresh user-verification immediately before a signing operation.
 *
 * A WebAuthn assertion over the registered platform credential with
 * `userVerification: 'required'` forces the authenticator to verify the human
 * (Touch ID / Windows Hello / device PIN) right now. Unlike `unlockWithPasskey`
 * this derives no key material and does not touch the PRF extension — the only
 * thing that matters is that the user was verified for THIS operation. It exists
 * because an already-unlocked vault caches its session key, so signing would
 * otherwise proceed with no user present.
 *
 * Fail-closed: throws if no credential is registered, or if the user cancels or
 * the authenticator fails. Callers MUST NOT sign when this throws.
 */
export async function requireUserVerification(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID)
  const credIdBase64 = stored[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID] as string | undefined
  if (!credIdBase64) {
    throw new Error(
      'USER_VERIFICATION_UNAVAILABLE: no passkey is registered on this device to verify you before signing.',
    )
  }

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{
        id: fromBase64Url(credIdBase64),
        type: 'public-key',
        transports: ['internal'],
      }],
      userVerification: 'required',
    },
  }) as PublicKeyCredential | null

  // A null assertion (or a NotAllowedError thrown out of get()) means the user
  // cancelled or the authenticator did not verify them. Either way, no signature.
  if (!assertion) {
    throw new Error('USER_VERIFICATION_CANCELLED: verification was cancelled.')
  }
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Check if a passkey has been registered for this extension.
 */
export async function hasPasskey(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID)
  return !!stored[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]
}
