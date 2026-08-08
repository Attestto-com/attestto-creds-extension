/**
 * Story 1.11 — characterization of `handleSignAttesttoPdfApprove` (Ed25519, WRITER).
 * Same real-`createGatedSign` harness (rawSign SPY + toggleable gate). APDF-specific
 * referents:
 *   - the bytes handed to the signer are byte-equal to `atob(payloadB64)` (opaque
 *     passthrough — the background never re-canonicalizes);
 *   - the 64-byte Ed25519 length guard (a 63-byte signature throws);
 *   - provisioning precedes signing and returns only the PUBLIC key;
 *   - keys-never-mirrored: the provisioning adapter mirrors through the REAL
 *     `toPublicVault`, which — with a deterministic Ed25519 `d` I control — never
 *     carries `ed25519PrivateKeyJwk`. (A fixture `d`, not an in-run mint, so the
 *     `not.toContain` is not trivially green.)
 */
import { describe, it, expect, vi } from 'vitest'
import { handleSignAttesttoPdfApprove } from './sign-attestto-pdf-approve.handler'
import { createGatedSign, type PresenceGate } from '@/background/crypto/gated-sign'
import { toPublicVault } from '@/utils/vault'
import type { VaultData } from '@/stores/wallet'

const SENTINEL = new Uint8Array(64).fill(0xa7) // valid Ed25519 length
const SENTINEL_B64 = btoa(String.fromCharCode(...SENTINEL))
const PAYLOAD_B64 = btoa('canonical-attestto-vc-bytes')

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:root',
    holderDid: undefined,
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', d: 'ROOT' } as JsonWebKey,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    linkedIdentities: [],
    ...overrides,
  }
}

function makeCtx(
  vault: VaultData | null,
  opts: { gate?: PresenceGate; rawBytes?: Uint8Array; provision?: { publicKeyB64: string } | null } = {},
) {
  const gate: PresenceGate = opts.gate ?? (async () => {})
  const rawSign = vi.fn(async (_p: Uint8Array) => ({ bytes: opts.rawBytes ?? SENTINEL }))
  const crypto = { sign: createGatedSign({ assertPresence: gate, rawSign }), deriveForOrigin: vi.fn() }
  const provisionEd25519 = vi.fn(async () => (opts.provision === undefined ? { publicKeyB64: 'EDPUBLICKEYB64xyz' } : opts.provision))
  const ctx = { store: { read: vi.fn(async () => vault) }, crypto, provisioning: { provisionEd25519 } }
  return { ctx, rawSign, provisionEd25519 }
}

describe('handleSignAttesttoPdfApprove — characterization (parity-to-legacy)', () => {
  it('happy path: signs the opaque payload via the gated Ed25519 signer', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({
      ok: true,
      did: 'did:x',
      signature: SENTINEL_B64,
      publicKey: 'EDPUBLICKEYB64xyz',
    })
  })

  it('PAYLOAD referent — the signer receives EXACTLY atob(payloadB64) (opaque, no re-canonicalize)', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())
    await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    const signed = rawSign.mock.calls[0][0] as Uint8Array
    const expected = Uint8Array.from(atob(PAYLOAD_B64), (c) => c.charCodeAt(0))
    expect(Array.from(signed)).toEqual(Array.from(expected))
  })

  it('LENGTH GUARD — a 63-byte signature throws → error result, no signature', async () => {
    const { ctx } = makeCtx(makeVault(), { rawBytes: new Uint8Array(63).fill(1) })
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Unexpected Ed25519 signature length: 63' })
  })

  it('holderDid fallback: selectedDid absent → vault.holderDid', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: 'did:holder' }))
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64 }, ctx)
    expect(result.ok && result.did).toBe('did:holder')
  })

  it('holderDid fallback: selectedDid + holderDid absent → did:key-vault:ed25519-<pub12>', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: undefined }))
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64 }, ctx)
    expect(result.ok && result.did).toBe('did:key-vault:ed25519-EDPUBLICKEYB') // first 12 chars of the pub
  })

  it('provisioning precedes signing; provision returns only the public key', async () => {
    const { ctx, provisionEd25519, rawSign } = makeCtx(makeVault())
    await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    expect(provisionEd25519).toHaveBeenCalledOnce()
    expect(rawSign).toHaveBeenCalledOnce()
    // the port surface exposes no private material
    const provided = await provisionEd25519.mock.results[0].value
    expect(Object.keys(provided)).toEqual(['publicKeyB64'])
  })

  it('provisioning fails (null) → "Could not load Ed25519 key", signer NOT called', async () => {
    const { ctx, rawSign } = makeCtx(makeVault(), { provision: null })
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Could not load Ed25519 key' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('vault locked (read → null) → "Vault not ready", provisioning NOT called', async () => {
    const { ctx, provisionEd25519 } = makeCtx(null)
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
    expect(provisionEd25519).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED — gate rejects → error, NO signature, rawSign NEVER called', async () => {
    const gate: PresenceGate = vi.fn(async () => {
      throw new Error('USER_VERIFICATION_CANCELLED')
    })
    const { ctx, rawSign } = makeCtx(makeVault(), { gate })
    const result = await handleSignAttesttoPdfApprove({ payloadB64: PAYLOAD_B64, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'USER_VERIFICATION_CANCELLED' })
    expect('signature' in result).toBe(false)
    expect(rawSign).not.toHaveBeenCalled()
  })
})

describe('APDF keys-never-mirrored — the provisioning seam mirrors through the real toPublicVault', () => {
  it('a vault carrying an Ed25519 private key mirrors to a public projection WITHOUT it', () => {
    // Deterministic `d` I control (not an in-run mint) — so `not.toContain` is a real
    // assertion, not trivially green. This is the strip the provisioning adapter routes
    // its syncPublicVault through; the handler has no mirror capability of its own.
    const vault = makeVault({
      ed25519PrivateKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'EDPUB', d: 'KNOWN_ED_SECRET' } as JsonWebKey,
      ed25519PublicKeyB64: 'EDPUBLICKEYB64xyz',
    } as Partial<VaultData>)

    const mirror = toPublicVault(vault)

    expect('ed25519PrivateKeyJwk' in mirror).toBe(false)
    expect(JSON.stringify(mirror)).not.toContain('KNOWN_ED_SECRET')
    // and the P-256 root private key is likewise absent
    expect(JSON.stringify(mirror)).not.toContain('"d"')
  })
})
