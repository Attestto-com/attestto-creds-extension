import { defineStore } from 'pinia'
import { ref } from 'vue'
import { encryptVault } from '@/utils/crypto'
import { readVault, writeVault, readPublicVault, syncPublicVault } from '@/utils/vault'
import { publicJwkToDid, didJwkVerificationMethod } from '@/utils/did-jwk'
import { setupPasskey, unlockWithPasskey, hasPasskey } from '@/utils/webauthn'
import { STORAGE_KEYS } from '@/config/app'
import { isValidSolanaAddress } from '@/utils/solana-address'
import { extractDidLabel } from '@/utils/did-label'
import type { StoredCredential, StoredKeyShare, ProofAccessRequest, PreparedPresentation } from '@/types/credential'
import type { SiteDidEntry } from '@/utils/site-did'

/**
 * A platform-synced identity linked to this vault.
 * Each identity maps to a tenant + wallet + compliance context on the platform.
 */
export interface LinkedIdentity {
  /** Platform-assigned DID (e.g. did:sns:chongkan.attestto.sol) */
  did: string
  /** Human-readable label (e.g. "chongkan.attestto.sol") */
  label: string
  /** DID Document verification method URI (e.g. did:web:...#key-1) */
  verificationMethod?: string
  /** Credentials associated with this identity */
  credentials: StoredCredential[]
  /** ISO timestamp of last sync with platform */
  syncedAt: string
  /** Platform tenant ID (for multi-tenant context) */
  tenantId?: string | null
}

export interface VaultData {
  /** Local device keypair DID (did:jwk:...) — used as fallback signer */
  did: string | null
  privateKeyJwk: JsonWebKey | null
  /**
   * Ed25519 keypair for Attestto self-attested PDF signing (ATT-364).
   * Lives alongside the legacy P-256 key — does NOT replace it.
   * Generated lazily on first PDF sign request. Independent of did/holderDid.
   *
   * publicKey is stored as raw 32 bytes base64 (the form
   * `attestto-self-attested.ts` verifier consumes directly).
   */
  ed25519PrivateKeyJwk?: JsonWebKey | null
  ed25519PublicKeyB64?: string | null
  /** @deprecated Use linkedIdentities[].credentials instead */
  credentials: StoredCredential[]
  linkedSolanaAddress: string | null
  keyShares: StoredKeyShare[]
  proofRequests: ProofAccessRequest[]
  preparedPresentations: PreparedPresentation[]
  /** @deprecated Use linkedIdentities[] instead */
  holderDid?: string | null
  /** @deprecated Use linkedIdentities[].verificationMethod instead */
  verificationMethod?: string
  /** Platform-synced identities — the primary identity model */
  linkedIdentities?: LinkedIdentity[]
  /**
   * Pairwise per-site login DIDs, keyed by normalized origin (`protocol//host`).
   * Each site gets a unique `did:jwk` so it cannot correlate the user across
   * the web. Never presented as identity — attributes flow only via VC.
   */
  siteDids?: Record<string, SiteDidEntry>
  /**
   * Retired per-site DIDs, keyed by origin. Archived (not deleted) when the
   * user removes a site identity, so signatures made with the old key remain
   * verifiable (forward-only revocation / point-in-time authority). The site's
   * next sign-in mints a fresh `did:jwk`.
   */
  archivedSiteDids?: Record<string, SiteDidEntry & { archivedAt: string }>
}

/**
 * Migrate legacy vault data to multi-identity model.
 * If `linkedIdentities` is missing but `holderDid` exists, create the first identity from it.
 * Moves root-level credentials into the identity's credential list.
 */
export function migrateVaultToMultiIdentity(vault: VaultData): VaultData {
  if (vault.linkedIdentities) return vault

  vault.linkedIdentities = []

  if (vault.holderDid && !vault.holderDid.startsWith('did:jwk:')) {
    vault.linkedIdentities.push({
      did: vault.holderDid,
      label: extractDidLabel(vault.holderDid),
      verificationMethod: vault.verificationMethod,
      credentials: vault.credentials ?? [],
      syncedAt: new Date().toISOString(),
      tenantId: null,
    })
  }

  return vault
}

export const useWalletStore = defineStore('wallet', () => {
  /** Public data loaded (credentials, DIDs — always available) */
  const isLoaded = ref(false)
  /** Private key available for signing (passkey was used) */
  const isUnlocked = ref(false)
  const did = ref<string | null>(null)
  const linkedSolanaAddress = ref<string | null>(null)
  /** Whether a passkey has been set up (checked on mount) */
  const isSetUp = ref(false)
  /** Platform-synced identities */
  const linkedIdentities = ref<LinkedIdentity[]>([])

  // Private in-memory reference to the private key (never exposed via template)
  let _privateKeyJwk: JsonWebKey | null = null

  /**
   * Check if a passkey has been registered.
   * Call this on component mount to determine lock screen vs setup screen.
   */
  async function checkSetup(): Promise<boolean> {
    isSetUp.value = await hasPasskey()
    return isSetUp.value
  }

  /**
   * Load public vault data — always works, no passkey needed.
   * Call on extension popup mount to show credentials immediately.
   *
   * Also installs a one-time chrome.storage.onChanged listener (per store
   * instance) so the popup auto-refreshes whenever the background mutates
   * the public vault — e.g. when an `attestto-id` credential offer is
   * auto-accepted on a trusted origin while the popup is already open.
   */
  let storageListenerInstalled = false
  async function loadPublicData(): Promise<void> {
    const pub = await readPublicVault()
    if (pub) {
      did.value = pub.did
      linkedSolanaAddress.value = pub.linkedSolanaAddress ?? null
      linkedIdentities.value = pub.linkedIdentities ?? []
    }
    isLoaded.value = true

    if (!storageListenerInstalled && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      storageListenerInstalled = true
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        if (!(STORAGE_KEYS.PUBLIC_VAULT in changes)) return
        const next = changes[STORAGE_KEYS.PUBLIC_VAULT].newValue as
          | { did: string | null; linkedSolanaAddress: string | null; linkedIdentities?: LinkedIdentity[] }
          | undefined
        if (!next) {
          did.value = null
          linkedSolanaAddress.value = null
          linkedIdentities.value = []
          return
        }
        did.value = next.did
        linkedSolanaAddress.value = next.linkedSolanaAddress ?? null
        linkedIdentities.value = next.linkedIdentities ?? []
      })
    }
  }

  /**
   * First-time setup: register a passkey and create an empty vault.
   * If PRF is supported by the authenticator → use it (touch-ID unlock).
   * If not → the supplied passphrase is used via Argon2id (passphrase-prompt unlock).
   *
   * @param passphrase  Required iff PRF is unavailable. The setup view should always
   *                    pass it (if user filled the field) so we can route correctly.
   */
  async function setup(passphrase?: string): Promise<void> {
    const setupResult = await setupPasskey(passphrase)
    const aesKeyBase64 = setupResult.aesKeyBase64

    // Generate vault signing keypair
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )

    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

    const newDid = publicJwkToDid(publicJwk)
    const vm = didJwkVerificationMethod(newDid)

    did.value = newDid
    _privateKeyJwk = privateJwk
    isUnlocked.value = true
    isSetUp.value = true

    const vault: VaultData = {
      did: newDid,
      privateKeyJwk: privateJwk,
      credentials: [],
      linkedSolanaAddress: null,
      keyShares: [],
      proofRequests: [],
      preparedPresentations: [],
      verificationMethod: vm,
      linkedIdentities: [],
    }

    const encrypted = await encryptVault(vault, aesKeyBase64)
    await chrome.storage.local.set({ [STORAGE_KEYS.VAULT]: encrypted })
    await syncPublicVault(vault)
    isLoaded.value = true
  }

  /**
   * Register a passkey on a vault that was created WITHOUT one, without
   * destroying its contents.
   *
   * The ATT-1098 signing gate (`requireUserVerification`) refuses to sign when
   * no passkey is registered. But a vault can legitimately exist with no
   * passkey — `createDid()` mints a vault protected by a random session key and
   * never enrolls a WebAuthn credential. For those users, `setup()` is the wrong
   * tool: it REPLACES the vault with an empty one, wiping DIDs, credentials, and
   * linked identities. This enrolls a passkey and re-encrypts the *existing*
   * vault under the passkey-derived key instead.
   *
   * If there is no vault at all (truly fresh device), it behaves like `setup()`
   * and mints a new signing key so the enroll still leaves a usable vault.
   *
   * @param passphrase  Required iff the authenticator does not support PRF —
   *                    surfaced as a tagged `PRF_REQUIRES_PASSPHRASE` error, same
   *                    as `setup()`.
   */
  async function enrollPasskey(passphrase?: string): Promise<void> {
    // Read the current vault BEFORE setupPasskey swaps the session key. If the
    // vault is unlocked (createDid/legacy session key present) this returns its
    // contents; if there is no vault it returns null and we mint a fresh one.
    const existing = await readVault().catch(() => null)

    // Register the passkey and derive the new vault key. This also caches the
    // derived key in session storage, so the re-encrypt below is under the key
    // future passkey unlocks will reproduce.
    const setupResult = await setupPasskey(passphrase)
    const aesKeyBase64 = setupResult.aesKeyBase64

    let vault: VaultData
    if (existing) {
      vault = existing
    } else {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      )
      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
      const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
      const newDid = publicJwkToDid(publicJwk)
      vault = {
        did: newDid,
        privateKeyJwk: privateJwk,
        credentials: [],
        linkedSolanaAddress: null,
        keyShares: [],
        proofRequests: [],
        preparedPresentations: [],
        verificationMethod: didJwkVerificationMethod(newDid),
        linkedIdentities: [],
      }
    }

    // Re-encrypt the (preserved or freshly minted) vault under the passkey key.
    const encrypted = await encryptVault(vault, aesKeyBase64)
    await chrome.storage.local.set({ [STORAGE_KEYS.VAULT]: encrypted })
    await syncPublicVault(vault)

    did.value = vault.did
    _privateKeyJwk = vault.privateKeyJwk
    linkedSolanaAddress.value = vault.linkedSolanaAddress ?? null
    linkedIdentities.value = vault.linkedIdentities ?? []
    isUnlocked.value = true
    isSetUp.value = true
    isLoaded.value = true
  }

  /**
   * Unlock the vault.
   * - If vault was set up with PRF: triggers passkey assertion, PRF re-derives the AES key.
   * - If vault was set up with passphrase: requires the passphrase param (Argon2id re-derives).
   *
   * If `passphrase` is needed but not provided, throws an error tagged `PASSPHRASE_REQUIRED`
   * so the unlock UI can prompt for it and call unlock again.
   */
  async function unlock(passphrase?: string): Promise<void> {
    // If no passkey registered, fall back to legacy unlock (session key)
    const passkeyExists = await hasPasskey()

    if (passkeyExists) {
      await unlockWithPasskey(passphrase)
    }

    // Read vault with the session key (set by unlockWithPasskey or legacy)
    const vault = await readVault()

    if (!vault) {
      // No vault data yet — unlocked but empty
      isUnlocked.value = true
      return
    }

    // Migrate legacy single-identity vault to multi-identity model
    const migrated = migrateVaultToMultiIdentity(vault)
    if (!vault.linkedIdentities) {
      // Persist the migration
      await writeVault(migrated)
      await syncPublicVault(migrated)
    }

    did.value = migrated.did
    _privateKeyJwk = migrated.privateKeyJwk
    linkedSolanaAddress.value = migrated.linkedSolanaAddress ?? null
    linkedIdentities.value = migrated.linkedIdentities ?? []
    isUnlocked.value = true
    isLoaded.value = true

    // Sync public vault so data is available without unlock next time
    await syncPublicVault(migrated)
  }

  /**
   * Lock the wallet — clear in-memory state.
   */
  function lock(): void {
    _privateKeyJwk = null
    isUnlocked.value = false

    // Clear the session key so private key can't be read without re-auth
    // Public data (did, credentials, identities) stays accessible
    chrome.storage.session.remove(STORAGE_KEYS.SESSION_KEY)
  }

  /**
   * **Destructive.** Wipe ALL wallet state — vault, public mirror, passkey credential ID,
   * PRF salt, passphrase salt, KDF method, trusted origins, site preferences, session key.
   *
   * Used to escape a vault that can't be unlocked (e.g., legacy vaults set up before
   * passphrase recovery shipped, where PRF turned out to be unavailable). The user is
   * then sent back through onboarding.
   */
  async function resetWallet(): Promise<void> {
    await chrome.storage.local.clear()
    await chrome.storage.session.clear()
    _privateKeyJwk = null
    did.value = null
    isUnlocked.value = false
    isSetUp.value = false
    isLoaded.value = false
    linkedSolanaAddress.value = null
    linkedIdentities.value = []
  }

  /**
   * Restore vault contents from a decrypted backup (see `vault-backup.ts`).
   *
   * Re-encrypts the restored data under THIS device's key and hydrates the
   * in-memory store. Requires an active session key — the caller must have just
   * run `setup()` (fresh device) or `unlock()` first, otherwise `writeVault`
   * throws "vault is locked".
   */
  async function restoreFromBackup(vault: VaultData): Promise<void> {
    const migrated = migrateVaultToMultiIdentity(vault)
    await writeVault(migrated)
    await syncPublicVault(migrated)

    did.value = migrated.did
    _privateKeyJwk = migrated.privateKeyJwk
    linkedSolanaAddress.value = migrated.linkedSolanaAddress ?? null
    linkedIdentities.value = migrated.linkedIdentities ?? []
    isUnlocked.value = true
    isSetUp.value = true
    isLoaded.value = true
  }

  /**
   * Archive the per-site DID for `origin`: move it out of the active
   * `siteDids` map into `archivedSiteDids` (kept for point-in-time
   * verification). The site's next sign-in mints a fresh `did:jwk`.
   *
   * Mutates the encrypted vault → requires an unlocked session. Throws
   * `PASSPHRASE_REQUIRED`-style `LOCKED` if called while locked.
   */
  async function archiveSiteDid(origin: string): Promise<void> {
    const vault = await readVault()
    if (!vault) throw new Error('LOCKED')
    const entry = vault.siteDids?.[origin]
    if (!entry) return

    const remaining = { ...(vault.siteDids ?? {}) }
    delete remaining[origin]
    const archived = { ...(vault.archivedSiteDids ?? {}) }
    archived[origin] = { ...entry, archivedAt: new Date().toISOString() }

    const next: VaultData = { ...vault, siteDids: remaining, archivedSiteDids: archived }
    await writeVault(next)
    await syncPublicVault(next)
  }

  /**
   * Create a new DID key pair, encrypt, and persist — **passkey-first**.
   *
   * Generates a proper `did:jwk` — self-resolving DID where the public key
   * is encoded in the identifier itself. Any Universal Resolver can construct
   * the DID Document without a network call.
   *
   * The vault is encrypted under a **passkey-derived key**, never a throwaway
   * random key. This restores the pre-ATT-724 invariant that every vault has a
   * registered passkey: before ATT-724 the popup forced `setup()` (which
   * enrolls a passkey) before any DID could exist, so signing always had a
   * credential to verify against. ATT-724 removed that gate, and this method —
   * reachable from the "Create DID" buttons — used to mint a vault under a
   * random key with NO passkey. Post-ATT-1098 (which requires a fresh
   * user-verification for every signature) those vaults could unlock but never
   * sign. Enrolling the passkey here closes that gap at the source.
   *
   * @param passphrase  Required only when the authenticator lacks WebAuthn PRF
   *                    — surfaced as a tagged `PRF_REQUIRES_PASSPHRASE` error
   *                    (fresh enroll) or `PASSPHRASE_REQUIRED` (existing
   *                    passphrase-KDF vault), same contract as `setup()`/
   *                    `unlock()`. Callers should reveal a passphrase field and
   *                    retry.
   */
  async function createDid(passphrase?: string): Promise<void> {
    // Obtain the vault key from the passkey. Reuse an already-registered
    // credential if one exists; otherwise enrol a new one. Both cache the
    // derived key in session storage, so the encrypt below is under the key
    // future unlocks reproduce.
    const aesKeyBase64 = (await hasPasskey())
      ? await unlockWithPasskey(passphrase)
      : (await setupPasskey(passphrase)).aesKeyBase64

    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )

    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

    const newDid = publicJwkToDid(publicJwk)
    const vm = didJwkVerificationMethod(newDid)

    did.value = newDid
    _privateKeyJwk = privateJwk
    isUnlocked.value = true
    isSetUp.value = true

    const vault: VaultData = {
      did: newDid,
      privateKeyJwk: privateJwk,
      credentials: [],
      linkedSolanaAddress: null,
      keyShares: [],
      proofRequests: [],
      preparedPresentations: [],
      verificationMethod: vm,
      linkedIdentities: [],
    }
    const encrypted = await encryptVault(vault, aesKeyBase64)

    await chrome.storage.local.set({ [STORAGE_KEYS.VAULT]: encrypted })
    await syncPublicVault(vault)
    isLoaded.value = true
  }

  /**
   * Get the private key JWK for signing operations.
   */
  function getPrivateKey(): JsonWebKey | null {
    return _privateKeyJwk
  }

  /**
   * Get the public key JWK (strips private fields from the stored private key).
   * Returns null if no keypair exists.
   */
  function getPublicKeyJwk(): JsonWebKey | null {
    if (!_privateKeyJwk) return null
    return {
      kty: _privateKeyJwk.kty,
      crv: _privateKeyJwk.crv,
      x: _privateKeyJwk.x,
      y: _privateKeyJwk.y,
    }
  }

  /**
   * Link a Solana wallet address. Validates it is a base58-encoded 32-byte key.
   */
  async function linkSolanaAddress(address: string): Promise<void> {
    if (!isValidSolanaAddress(address)) {
      throw new Error('Invalid Solana address')
    }

    linkedSolanaAddress.value = address

    const vault = await readVault()
    if (vault) {
      vault.linkedSolanaAddress = address
      await writeVault(vault)
      await syncPublicVault(vault)
    }
  }

  /**
   * Unlink the Solana wallet address.
   */
  async function unlinkSolanaAddress(): Promise<void> {
    linkedSolanaAddress.value = null

    const vault = await readVault()
    if (vault) {
      vault.linkedSolanaAddress = null
      await writeVault(vault)
      await syncPublicVault(vault)
    }
  }

  /**
   * Fetch credentials from the platform vault for a specific linked identity.
   * DID-authenticated: signs a challenge with the vault key, no session needed.
   * Returns the fetched credentials and stores them in the identity.
   */
  async function fetchFromVault(
    identityDid: string
  ): Promise<StoredCredential[]> {
    if (!_privateKeyJwk) throw new Error('Vault is locked')

    const identity = linkedIdentities.value.find((id) => id.did === identityDid)
    if (!identity) throw new Error('Identity not found')

    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:3333/api'
    const timestamp = String(Date.now())
    const payload = `vault-fetch:${identityDid}:${timestamp}`

    // Sign the challenge with vault P-256 key
    const key = await crypto.subtle.importKey(
      'jwk',
      _privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )

    const data = new TextEncoder().encode(payload)
    const sigBuffer = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      data
    )

    const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))

    const publicKeyJwk = getPublicKeyJwk()
    if (!publicKeyJwk) throw new Error('No public key available')

    const pkjB64 = btoa(JSON.stringify(publicKeyJwk))

    const params = new URLSearchParams({
      did: identityDid,
      timestamp,
      signature,
      publicKeyJwk: pkjB64,
    })

    const res = await fetch(`${apiBase}/ssi/public/vault-credentials?${params}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Fetch failed: ${res.status}`)
    }

    const json = await res.json()
    const credentials: StoredCredential[] = (json.data ?? []).map(
      (vc: Record<string, unknown>) => ({
        id: vc.id as string,
        type: vc.type as string,
        issuedAt: vc.issuedAt as string,
        expiresAt: (vc.expiresAt as string) ?? undefined,
        json: JSON.stringify(vc),
      })
    )

    // Update the identity's credentials and persist
    identity.credentials = credentials
    identity.syncedAt = new Date().toISOString()

    const vault = await readVault()
    if (vault && vault.linkedIdentities) {
      const idx = vault.linkedIdentities.findIndex((id) => id.did === identityDid)
      if (idx >= 0) {
        vault.linkedIdentities[idx].credentials = credentials
        vault.linkedIdentities[idx].syncedAt = identity.syncedAt
      }
      await writeVault(vault)
      await syncPublicVault(vault)
    }

    return credentials
  }

  return {
    isLoaded,
    isUnlocked,
    isSetUp,
    did,
    linkedSolanaAddress,
    linkedIdentities,
    checkSetup,
    loadPublicData,
    setup,
    enrollPasskey,
    unlock,
    lock,
    resetWallet,
    restoreFromBackup,
    archiveSiteDid,
    createDid,
    getPrivateKey,
    getPublicKeyJwk,
    linkSolanaAddress,
    unlinkSolanaAddress,
    fetchFromVault,
  }
})
