/**
 * Story 1.13 Phase 1b — the signing-tier adapter factory. Verifies the WIRING that
 * moved off the entrypoint (the entrypoint itself is `defineBackground`, untestable):
 * each raw signer signs, `provision*` write+mirror and return PUBLIC material + a
 * bound signer, and effects route through the INJECTED deps (not `chrome.*`).
 *
 * Real WebCrypto (P-256 / Ed25519) is used for round-trips — Node's webcrypto
 * supports both — so a signature is a real signature, not a stubbed shape.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { createSigningAdapters, es256RawSign, type SigningAdapterDeps } from './signing-adapters'
import type { VaultData } from '@/stores/wallet'
import type { SiteDidEntry } from '@/utils/site-did'
import { DEFERRED_PRESENCE_PASSTHROUGH } from '@/background/crypto/gated-sign'

let p256Jwk: JsonWebKey

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']))
  p256Jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
})

function makeDeps(over: Partial<SigningAdapterDeps> & { vault?: VaultData | null } = {}): {
  deps: SigningAdapterDeps
  writeVault: ReturnType<typeof vi.fn>
  syncPublicVault: ReturnType<typeof vi.fn>
  pinSite: ReturnType<typeof vi.fn>
} {
  const vault: VaultData | null = over.vault === undefined ? ({ privateKeyJwk: p256Jwk } as VaultData) : over.vault
  const writeVault = vi.fn(async () => {})
  const syncPublicVault = vi.fn(async () => {})
  const pinSite = vi.fn(async () => {})
  const deps: SigningAdapterDeps = {
    readVault: vi.fn(async () => vault),
    writeVault,
    syncPublicVault,
    findOrCreateSiteDid: vi.fn(async (_siteDids, origin) => {
      const entry = { did: `did:site:${origin}`, privateKeyJwk: p256Jwk, lastUsedAt: '' } as unknown as SiteDidEntry
      return { siteDids: { [origin]: entry }, entry, created: true, key: origin }
    }),
    publicJwkOf: vi.fn(() => ({ kty: 'EC', crv: 'P-256', x: 'X', y: 'Y' })),
    pinSite,
    // SOC-279 — required, no default. Tests that care about the gate override it.
    assertPresence: DEFERRED_PRESENCE_PASSTHROUGH,
    ...over,
  }
  return { deps, writeVault, syncPublicVault, pinSite }
}

describe('createSigningAdapters — rootRawSign', () => {
  it('reads the vault and produces a real signature', async () => {
    const { deps } = makeDeps()
    const a = createSigningAdapters(deps)
    const sig = await a.rootRawSign(new Uint8Array([1, 2, 3]))
    expect(sig.bytes).toBeInstanceOf(Uint8Array)
    expect(sig.bytes.length).toBe(64) // P-256 raw r||s
    expect(deps.readVault).toHaveBeenCalled()
  })

  it('throws when the vault is locked (no root key)', async () => {
    const { deps } = makeDeps({ vault: null })
    const a = createSigningAdapters(deps)
    await expect(a.rootRawSign(new Uint8Array([1]))).rejects.toThrow(/vault locked|unavailable/i)
  })
})

describe('createSigningAdapters — provisionEd25519', () => {
  it('generates the key, writes + mirrors, returns PUBLIC key + a bound signer', async () => {
    const { deps, writeVault, syncPublicVault } = makeDeps({ vault: {} as VaultData })
    const a = createSigningAdapters(deps)
    const r = await a.provisionEd25519()
    expect(r).not.toBeNull()
    expect(typeof r!.publicKeyB64).toBe('string')
    expect(writeVault).toHaveBeenCalledOnce()
    expect(syncPublicVault).toHaveBeenCalledOnce() // public Ed25519 key mirrored
    const sig = await r!.rawSign(new Uint8Array([9]))
    expect(sig.bytes.length).toBe(64) // Ed25519 signature
  })

  it('returns null when the vault is locked', async () => {
    const { deps } = makeDeps({ vault: null })
    expect(await createSigningAdapters(deps).provisionEd25519()).toBeNull()
  })
})

describe('createSigningAdapters — provisionSiteDid', () => {
  it('stamps lastUsedAt, writes + mirrors, returns did/publicJwk + a bound per-site signer', async () => {
    const { deps, writeVault, syncPublicVault } = makeDeps()
    const a = createSigningAdapters(deps)
    const r = await a.provisionSiteDid('https://x.com')
    expect(r!.did).toBe('did:site:https://x.com')
    expect(r!.publicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'X', y: 'Y' })
    expect(writeVault).toHaveBeenCalledOnce()
    expect(syncPublicVault).toHaveBeenCalledOnce()
    const sig = await r!.rawSign(new Uint8Array([1]))
    expect(sig.bytes.length).toBe(64) // signs with the per-site P-256 key
  })

  it('returns null when the vault is locked', async () => {
    const { deps } = makeDeps({ vault: null })
    expect(await createSigningAdapters(deps).provisionSiteDid('https://x.com')).toBeNull()
  })
})

describe('createSigningAdapters — pin / store', () => {
  it('pin routes to the injected pinSite', async () => {
    const { deps, pinSite } = makeDeps()
    await createSigningAdapters(deps).pin.pin('x.com')
    expect(pinSite).toHaveBeenCalledWith('x.com')
  })

  it('store.read routes to the injected readVault', async () => {
    const { deps } = makeDeps()
    await createSigningAdapters(deps).store.read()
    expect(deps.readVault).toHaveBeenCalled()
  })

  // The `deriveForOrigin is not wired (throws)` case was removed with the method
  // itself (SOC-243). It asserted the shape of a stub for a design that was
  // rejected: root-derived per-site keys would make the root key a master key
  // over every relying party. Site keys are independent and random.
})

describe('es256RawSign — exported for the transitional notification-path signer', () => {
  it('produces a 64-byte P-256 signature over the payload', async () => {
    const sig = await es256RawSign(p256Jwk, new Uint8Array([1, 2, 3]))
    expect(sig.bytes.length).toBe(64)
  })
})
