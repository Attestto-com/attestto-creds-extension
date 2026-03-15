import { defineStore } from 'pinia'
import { ref } from 'vue'
import { encryptVault, generateEncryptionKey } from '@/utils/crypto'
import { readVault, writeVault } from '@/utils/vault'
import { publicJwkToDid, didJwkVerificationMethod } from '@/utils/did-jwk'
import { STORAGE_KEYS } from '@/config/app'
import { PublicKey } from '@solana/web3.js'
import type { StoredCredential, StoredKeyShare, ProofAccessRequest, PreparedPresentation } from '@/types/credential'

export interface VaultData {
  did: string | null
  privateKeyJwk: JsonWebKey | null
  credentials: StoredCredential[]
  linkedSolanaAddress: string | null
  keyShares: StoredKeyShare[]
  proofRequests: ProofAccessRequest[]
  preparedPresentations: PreparedPresentation[]
  /** Full DID used as holder in VP presentations (defaults to did field) */
  holderDid?: string | null
  /** DID Document verification method URI for proof signing (e.g. did:web:...#key-1) */
  verificationMethod?: string
}

export const useWalletStore = defineStore('wallet', () => {
  const isUnlocked = ref(false)
  const did = ref<string | null>(null)
  const linkedSolanaAddress = ref<string | null>(null)

  // Private in-memory reference to the private key (never exposed via template)
  let _privateKeyJwk: JsonWebKey | null = null

  /**
   * Unlock the vault by loading the encrypted blob from chrome.storage.local
   * and decrypting it with the session key from chrome.storage.session.
   */
  async function unlock(): Promise<void> {
    const vault = await readVault()

    if (!vault) {
      isUnlocked.value = true
      return
    }

    did.value = vault.did
    _privateKeyJwk = vault.privateKeyJwk
    linkedSolanaAddress.value = vault.linkedSolanaAddress ?? null
    isUnlocked.value = true
  }

  /**
   * Lock the wallet — clear in-memory state.
   */
  function lock(): void {
    did.value = null
    _privateKeyJwk = null
    linkedSolanaAddress.value = null
    isUnlocked.value = false
  }

  /**
   * Create a new DID key pair, encrypt, and persist.
   *
   * Generates a proper `did:jwk` — self-resolving DID where the public key
   * is encoded in the identifier itself. Any Universal Resolver can construct
   * the DID Document without a network call.
   *
   * The verification method follows the did:jwk spec: `<did>#0`.
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
    }
    const encrypted = await encryptVault(vault, encKey)

    await chrome.storage.local.set({ [STORAGE_KEYS.VAULT]: encrypted })
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_KEY]: encKey })
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
    }
  }

  return { isUnlocked, did, linkedSolanaAddress, unlock, lock, createDid, getPrivateKey, getPublicKeyJwk, linkSolanaAddress, unlinkSolanaAddress }
})
