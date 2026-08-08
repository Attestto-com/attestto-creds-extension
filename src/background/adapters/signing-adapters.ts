/**
 * Story 1.13 Phase 1b — the SIGNING-tier adapters (composition-root wiring).
 *
 * Moves the real signing crypto OFF the entrypoint: `es256RawSign` (P-256),
 * Ed25519 provisioning+sign, and the per-site DID provisioning. `createBuildBundle`
 * wraps these raw signers in the ONE gated `crypto.sign` — so `subtle.sign` lives
 * here (an injectable, unit-testable factory), never in `background.ts` (the F1
 * capability fence). Effects (vault I/O, site-DID store, pin) are INJECTED, so the
 * factory is testable without `chrome.*`.
 *
 * `assertPresence` is a documented passthrough (parity): all five APPROVE cases
 * signed with a noop gate before 1.13; wiring the real WebAuthn liveness gate is a
 * later story, one axis at a time. `provision*` return only PUBLIC material (AD-2);
 * the private key stays inside the returned `rawSign` closure — never a bundle field.
 */
import type { VaultData } from '@/stores/wallet'
import type { SiteDidEntry } from '@/utils/site-did'
import type { SigningAdapters } from '@/background/ctx/build-bundle'
import type { RawSign, PresenceGate } from '@/background/crypto/gated-sign'
import type { Signature } from '@/background/ports/ports'

/** Effects the signing adapters need — injected so the factory is testable. */
export interface SigningAdapterDeps {
  readVault: () => Promise<VaultData | null>
  writeVault: (v: VaultData) => Promise<void>
  syncPublicVault: (v: VaultData) => Promise<void>
  findOrCreateSiteDid: (
    siteDids: Record<string, SiteDidEntry> | undefined,
    origin: string,
  ) => Promise<{ siteDids: Record<string, SiteDidEntry>; entry: SiteDidEntry; created: boolean; key: string }>
  publicJwkOf: (entry: SiteDidEntry) => { kty: string; crv: string; x: string; y: string }
  pinSite: (host: string) => Promise<unknown>
  /** Passthrough by default (parity); the composition root can inject the real gate later. */
  assertPresence?: PresenceGate
}

/** Sign `payload` with a P-256 private JWK (ECDSA/SHA-256). The one raw ES256 signer. */
export async function es256RawSign(privateJwk: JsonWebKey, payload: Uint8Array): Promise<Signature> {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const buf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload as BufferSource)
  return { bytes: new Uint8Array(buf) }
}

/** Sign `payload` with an unwrapped Ed25519 `CryptoKey`. */
async function ed25519RawSign(key: CryptoKey, payload: Uint8Array): Promise<Signature> {
  const buf = await crypto.subtle.sign({ name: 'Ed25519' }, key, payload as BufferSource)
  return { bytes: new Uint8Array(buf) }
}

export function createSigningAdapters(deps: SigningAdapterDeps): SigningAdapters {
  const assertPresence: PresenceGate = deps.assertPresence ?? (async () => {})

  const rootRawSign: RawSign = async (payload) => {
    const v = await deps.readVault()
    if (!v?.privateKeyJwk) throw new Error('Root signing key unavailable (vault locked)')
    return es256RawSign(v.privateKeyJwk, payload)
  }

  const provisionEd25519 = async (): Promise<{ publicKeyB64: string; rawSign: RawSign } | null> => {
    const vault = await deps.readVault()
    if (!vault) return null

    if (vault.ed25519PrivateKeyJwk && vault.ed25519PublicKeyB64) {
      try {
        const key = await crypto.subtle.importKey('jwk', vault.ed25519PrivateKeyJwk, { name: 'Ed25519' }, false, ['sign'])
        return { publicKeyB64: vault.ed25519PublicKeyB64, rawSign: (p) => ed25519RawSign(key, p) }
      } catch {
        /* fall through and regenerate */
      }
    }

    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const publicKeyB64 = btoa(String.fromCharCode(...rawPub))
    vault.ed25519PrivateKeyJwk = privateKeyJwk
    vault.ed25519PublicKeyB64 = publicKeyB64
    await deps.writeVault(vault)
    await deps.syncPublicVault(vault) // mirror the PUBLIC Ed25519 key only
    return { publicKeyB64, rawSign: (p) => ed25519RawSign(pair.privateKey, p) }
  }

  const provisionSiteDid = async (
    origin: string,
  ): Promise<{ did: string; publicKeyJwk: JsonWebKey; rawSign: RawSign } | null> => {
    const vault = await deps.readVault()
    if (!vault) return null
    const { siteDids, entry } = await deps.findOrCreateSiteDid(vault.siteDids, origin)
    entry.lastUsedAt = new Date().toISOString()
    vault.siteDids = siteDids
    await deps.writeVault(vault)
    await deps.syncPublicVault(vault)
    const sitePrivateKeyJwk = entry.privateKeyJwk
    return {
      did: entry.did,
      publicKeyJwk: deps.publicJwkOf(entry) as JsonWebKey,
      rawSign: (p) => es256RawSign(sitePrivateKeyJwk, p),
    }
  }

  return {
    store: { read: () => deps.readVault() },
    // `vault` is SigningCtx's confinement seam (VaultRead, read-only) — no handler
    // consumes it (they use `store`); an opaque record satisfies the type.
    vault: { read: async () => ({ kind: 'signing-vault' }) },
    clock: { now: () => Date.now() },
    pin: { pin: async (host: string) => { await deps.pinSite(host) } },
    // AD-11a pairwise derivation is not wired here (Epic 2); no signing handler calls it.
    deriveForOrigin: async () => { throw new Error('deriveForOrigin not wired (AD-11a, Epic 2)') },
    assertPresence,
    rootRawSign,
    provisionEd25519,
    provisionSiteDid,
  }
}
