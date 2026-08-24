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
 *
 * ── There is no passphrase here, and that is the design ──────────────────
 *
 * The vault KDF used to fall back to Argon2id over a user passphrase whenever
 * PRF looked unavailable. That fallback is DELETED, for two reasons:
 *
 *   1. It made the wallet's core claim uncheckable. A passphrase unlock yields
 *      a signature indistinguishable from a passkey-backed one, so "passkey-
 *      protected" became a statement nobody could verify — the exact defect the
 *      workspace rule names. With PRF as the only path, the claim is true by
 *      construction rather than by hope.
 *   2. It bought recovery the wallet does not need. The vault is DISPOSABLE:
 *      it holds a device-local key and re-issuable credentials, never bearer
 *      assets. A lost device is replaced by installing the extension again,
 *      minting a fresh DID, and re-binding that DID to the user's account
 *      through the platform's normal link flow. The account is the recovery
 *      anchor; a passphrase never was.
 *
 * The cost is deliberate and stated plainly: an authenticator that cannot do
 * PRF cannot hold a vault, and setup FAILS with `PRF_UNSUPPORTED` instead of
 * silently downgrading. Refusing is honest; downgrading is not.
 *
 * Argon2id still exists in `passphrase-kdf.ts` — `services/vault-backup.ts`
 * encrypts an explicitly exported backup FILE with it. That is a deliberate
 * export from Settings, never part of setup, login, or an approval.
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
  /**
   * `enabled` is reported by `create()`, `results` by `get()` — and conflating
   * them is what made this file demand a passphrase from PRF-capable hardware.
   *
   * Chrome does not evaluate `prf.eval` during registration on a platform
   * authenticator. It answers `{ enabled: true }`, meaning "PRF works here, ask
   * again in an assertion". The old code read only `results.first` off the
   * REGISTRATION response, got undefined, and concluded PRF was unsupported.
   * Touch ID, Windows Hello and iCloud Keychain all land in that branch.
   */
  prf?: { enabled?: boolean; results?: PrfValues }
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
}

/**
 * Setup found an authenticator that cannot produce a PRF secret.
 *
 * Fail-closed and terminal: there is no passphrase to fall back to, by design
 * (see the module header). The UI turns this into "this browser/device cannot
 * secure a wallet — use another one", never into a password field.
 */
export const PRF_UNSUPPORTED =
  'PRF_UNSUPPORTED: That passkey cannot secure a wallet. It does not support the PRF ' +
  'extension, which is what encrypts your vault. Try again and choose a different option ' +
  'when your browser asks — a phone or a security key will work. Some browsers\' built-in ' +
  'passkey managers do not support it.'

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
 * Register a passkey and derive the vault key from its PRF secret.
 *
 * One prompt-shape, one outcome: PRF or `PRF_UNSUPPORTED`. There is no
 * passphrase parameter and no downgrade path — see the module header.
 *
 * On a fresh setup macOS/Windows show the authenticator TWICE in a row: once to
 * create the credential, once to evaluate PRF over it. That second prompt is
 * inherent to how browsers expose the extension (registration reports `enabled`,
 * only an assertion yields `results`) and cannot be collapsed by this code.
 */
export async function setupPasskey(): Promise<SetupResult> {
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

  if (existingCredId && existingSalt) {
    /**
     * A passkey is already in the keychain from a previous attempt. Reuse it
     * rather than minting another — re-registering stacks orphan credentials
     * the user then sees forever in their password manager.
     *
     * The credential ID is persisted IMMEDIATELY on creation, before PRF
     * support is known, so ANY interrupted first attempt leaves one behind.
     * Asking the authenticator is therefore the only correct move here.
     */
    const prfResult = await tryPrfAssertion(existingCredId, existingSalt)
    if (prfResult) {
      const aesKeyBase64 = await deriveAesKey(prfResult, fromBase64Url(existingSalt))
      await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64 })
      return { aesKeyBase64 }
    }

    /**
     * 🩸 THE DEAD END. This credential cannot produce a PRF secret, so it can
     * never open a vault — and until now its id stayed in storage.
     *
     * That made setup permanently unrecoverable from the UI. Every retry took
     * this branch, and `allowCredentials` PINS the assertion to exactly this
     * credential, so the browser went straight to its own prompt for the one
     * passkey that cannot work, with no picker and no way to choose a different
     * authenticator. The user could press "Set up" forever and see the same
     * refusal. Observed in Brave, whose built-in passkey store does not
     * implement the PRF/hmac-secret extension.
     *
     * So we forget it. We cannot DELETE the credential — WebAuthn gives a site
     * no API to remove one; that is the user's password manager to clean up —
     * but we can stop pointing at it, which is what actually traps them. The
     * next attempt falls through to `create()` and the browser offers the full
     * picker again, including a phone or security key that does support PRF.
     */
    await chrome.storage.local.remove([
      STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID,
      STORAGE_KEYS.PRF_SALT,
    ])
    throw new Error(PRF_UNSUPPORTED)
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
        // `authenticatorAttachment: 'platform'` was here and is deliberately
        // gone. It restricted the ceremony to THIS device's built-in store, so
        // on a browser whose built-in store lacks PRF — Brave's, for one — the
        // prompt appeared instantly with no picker and no way to choose
        // anything else. There was no authenticator the user could reach that
        // would have worked.
        //
        // Unconstrained, the browser offers its full picker: the platform
        // authenticator, a phone over hybrid, or a security key. The latter two
        // implement hmac-secret and so satisfy PRF. Nothing is weakened —
        // `userVerification: 'required'` still forces a verified human, which is
        // the property the signing gate depends on, and it is enforced whatever
        // the user picks.
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

  /**
   * 🩸 The registration response is NOT authoritative about PRF support.
   *
   * Chrome answers `create()` with `prf: { enabled: true }` and no `results` on
   * every platform authenticator — the secret is only ever produced by an
   * assertion. Reading `results.first` here and giving up was the bug: it
   * declared PRF unsupported on hardware that supports it perfectly, which is
   * how a password field ended up in a flow that is supposed to have none.
   *
   * So `results` is a fast path, not the test. When it is absent we ASK, via
   * the same assertion the returning-user unlock uses. Only an explicit
   * `enabled === false` is taken as a real answer and short-circuits the extra
   * prompt; `undefined` is treated as "unknown, go and find out", because
   * browsers disagree about reporting it at all.
   */
  let prfResult = extensions.prf?.results?.first ?? null

  if (!prfResult && extensions.prf?.enabled !== false) {
    prfResult = await tryPrfAssertion(toBase64Url(credential.rawId), toBase64Url(prfSalt.buffer))
  }

  if (!prfResult) {
    throw new Error(PRF_UNSUPPORTED)
  }

  const aesKeyBase64 = await deriveAesKey(prfResult, prfSalt.buffer)

  // Cache the derived key in session storage (cleared on browser close)
  await chrome.storage.session.set({
    [STORAGE_KEYS.SESSION_KEY]: aesKeyBase64,
  })

  return { aesKeyBase64 }
}


// ── WebAuthn Unlock (returning user) ────────────────────

/**
 * Unlock the vault: WebAuthn assertion + PRF → HKDF-derived AES key.
 *
 * One path, no parameters, no branch on a recorded KDF method — there is only
 * one method. The assertion runs with `userVerification: 'required'`, so a
 * successful unlock IS a fresh user-verification; callers rely on that to avoid
 * prompting the user a second time for the same interaction.
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
    // The vault exists but this authenticator will not reproduce its key. No
    // passphrase escape hatch exists, and that is correct: the vault is
    // disposable. Reset and set up again — a fresh DID re-binds to the user's
    // account through the normal link flow.
    throw new Error(
      'PRF_UNAVAILABLE: Your passkey did not return the secret that unlocks this vault. ' +
      'Reset the wallet and set it up again.',
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
