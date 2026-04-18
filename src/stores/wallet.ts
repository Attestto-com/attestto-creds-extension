import { defineStore } from 'pinia'
import { ref } from 'vue'
import { encryptVault, generateEncryptionKey } from '@/utils/crypto'
import { readVault, writeVault, readPublicVault, syncPublicVault } from '@/utils/vault'
import { publicJwkToDid, didJwkVerificationMethod } from '@/utils/did-jwk'
import { setupPasskey, unlockWithPasskey, hasPasskey } from '@/utils/webauthn'
import { STORAGE_KEYS } from '@/config/app'
import { PublicKey } from '@solana/web3.js'
import type { StoredCredential, StoredKeyShare, ProofAccessRequest, PreparedPresentation } from '@/types/credential'

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

/** Extract a human-readable label from a DID string. */
function extractDidLabel(did: string): string {
  const snsMatch = did.match(/^did:sns:(.+)$/)
  if (snsMatch) return snsMatch[1]

  const webMatch = did.match(/^did:web:(.+)$/)
  if (webMatch) return webMatch[1].replace(/:/g, '/')

  return did
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
   */
  async function loadPublicData(): Promise<void> {
    const pub = await readPublicVault()
    if (pub) {
      did.value = pub.did
      linkedSolanaAddress.value = pub.linkedSolanaAddress ?? null
      linkedIdentities.value = pub.linkedIdentities ?? []
    }
    isLoaded.value = true
  }

  /**
   * First-time setup: register a passkey and create an empty vault.
   * The passkey's PRF output is used to derive the vault encryption key.
   */
  async function setup(): Promise<void> {
    const aesKeyBase64 = await setupPasskey()

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
   * Unlock the vault using the registered passkey.
   * WebAuthn PRF re-derives the same AES key used during setup.
   */
  async function unlock(): Promise<void> {
    // If no passkey registered, fall back to legacy unlock (session key)
    const passkeyExists = await hasPasskey()

    if (passkeyExists) {
      await unlockWithPasskey()
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
   * Create a new DID key pair, encrypt, and persist.
   *
   * Generates a proper `did:jwk` — self-resolving DID where the public key
   * is encoded in the identifier itself. Any Universal Resolver can construct
   * the DID Document without a network call.
   */
  async function createDid(): Promise<void> {
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

    const encKey = await generateEncryptionKey()
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
    const encrypted = await encryptVault(vault, encKey)

    await chrome.storage.local.set({ [STORAGE_KEYS.VAULT]: encrypted })
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_KEY]: encKey })
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
   * Link a Solana wallet address. Validates base58 via PublicKey constructor.
   */
  async function linkSolanaAddress(address: string): Promise<void> {
    // Validate — throws if invalid base58 public key
    new PublicKey(address)

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
    unlock,
    lock,
    createDid,
    getPrivateKey,
    getPublicKeyJwk,
    linkSolanaAddress,
    unlinkSolanaAddress,
    fetchFromVault,
  }
})
