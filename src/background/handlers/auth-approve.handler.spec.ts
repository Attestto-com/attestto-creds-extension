/**
 * Story 1.11 — characterization of `handleAuthApprove` (login; both protocols).
 * The strongest per-family referent in the story: a REAL P-256 per-site key + a
 * REAL `crypto.subtle.verify`. The emitted signature must verify against the
 * emitted public key over the exact canonical payload — which catches the
 * "sign with the root key but return the pairwise pubkey" swap (the signature
 * would not verify) and any canonical-payload drift.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleAuthApprove } from './auth-approve.handler'
import { createGatedSign, type PresenceGate } from '@/background/crypto/gated-sign'
import { canonicalAuthMessage } from '@/services/did-auth'
import { toPublicVault } from '@/utils/vault'
import type { VaultData } from '@/stores/wallet'

const CLOCK_MS = 1_700_000_000_000
const CLOCK_ISO = new Date(CLOCK_MS).toISOString()

function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

async function makeCtx(opts: { gate?: PresenceGate; provision?: 'null' | 'throw' | 'ok'; pinRejects?: boolean } = {}) {
  const mode = opts.provision ?? 'ok'
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const publicKeyJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } as JsonWebKey
  const did = 'did:jwk:site-alice'

  // rawSign signs with the REAL pairwise private key — so subtle.verify can check it.
  const rawSign = vi.fn(async (payload: Uint8Array) => {
    const buf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, payload as BufferSource)
    return { bytes: new Uint8Array(buf) }
  })
  const gate: PresenceGate = opts.gate ?? (async () => {})
  const provisionSiteDid = vi.fn(async () => {
    if (mode === 'null') return null
    if (mode === 'throw') throw new Error('Invalid origin for site DID')
    return { did, publicKeyJwk }
  })
  const pin = { pin: vi.fn(async () => { if (opts.pinRejects) throw new Error('pin store unavailable') }) }
  const ctx = {
    crypto: { sign: createGatedSign({ assertPresence: gate, rawSign }), deriveForOrigin: vi.fn() },
    provisioning: { provisionSiteDid },
    pin,
    clock: { now: () => CLOCK_MS },
  }
  return { ctx, publicKeyJwk, did, kp, rawSign, pin, provisionSiteDid }
}

async function verify(publicKeyJwk: JsonWebKey, sig: Uint8Array, message: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig as BufferSource, new TextEncoder().encode(message))
}

const legacyInput = { origin: 'https://verifier.example', nonce: 'nonce-1', timestamp: '2026-07-19T12:00:00.000Z' }
const cwInput = { protocol: 'cw' as const, origin: 'https://verifier.example', nonce: 'nonce-1', timestamp: '2026-07-19T12:00:00.000Z', audience: 'https://aud.example' }

describe('handleAuthApprove — legacy attestto:auth', () => {
  it('REAL VERIFY — emitted signature verifies against the emitted pairwise pubkey', async () => {
    const { ctx, publicKeyJwk, did } = await makeCtx()
    const result = await handleAuthApprove(legacyInput, ctx)
    if (!result.ok || result.kind !== 'legacy') throw new Error('expected legacy ok')

    expect(result.did).toBe(did)
    expect(result.publicKeyJwk).toEqual(publicKeyJwk)
    expect(result.nonce).toBe('nonce-1')
    expect(result.timestamp).toBe('2026-07-19T12:00:00.000Z')

    const canonical = `nonce-1|https://verifier.example|https://verifier.example|2026-07-19T12:00:00.000Z`
    expect(await verify(result.publicKeyJwk, base64ToBytes(result.signature), canonical)).toBe(true)
    // and NOT over a tampered payload (binds the exact canonical)
    expect(await verify(result.publicKeyJwk, base64ToBytes(result.signature), canonical + 'X')).toBe(false)
  })

  it('pins the site (www-stripped host), best-effort', async () => {
    const { ctx, pin } = await makeCtx()
    await handleAuthApprove({ ...legacyInput, origin: 'https://www.verifier.example' }, ctx)
    expect(pin.pin).toHaveBeenCalledWith('verifier.example')
  })

  it('a pin failure never blocks sign-in', async () => {
    const { ctx } = await makeCtx({ pinRejects: true })
    const result = await handleAuthApprove(legacyInput, ctx)
    expect(result.ok).toBe(true)
  })
})

describe('handleAuthApprove — cw credential-wallet:auth', () => {
  it('REAL VERIFY — response signature verifies over the canonical auth message; fresh timestamp', async () => {
    const { ctx, publicKeyJwk, did } = await makeCtx()
    const result = await handleAuthApprove(cwInput, ctx)
    if (!result.ok || result.kind !== 'cw') throw new Error('expected cw ok')

    const r = result.response
    expect(r.approved).toBe(true)
    expect(r.did).toBe(did)
    expect(r.audience).toBe('https://aud.example')
    expect(r.timestamp).toBe(CLOCK_ISO) // fresh, from the injected clock (not the request ts)

    const message = canonicalAuthMessage({ did: r.did, nonce: r.nonce, audience: r.audience, origin: r.origin, timestamp: r.timestamp })
    expect(await verify(publicKeyJwk, base64urlToBytes(r.signature), message)).toBe(true)
  })

  it('audience falls back to origin when absent', async () => {
    const { ctx } = await makeCtx()
    const result = await handleAuthApprove({ ...cwInput, audience: undefined }, ctx)
    if (!result.ok || result.kind !== 'cw') throw new Error('expected cw ok')
    expect(result.response.audience).toBe('https://verifier.example')
  })
})

describe('handleAuthApprove — guards & fail-closed', () => {
  it('provisionSiteDid null (locked) → "Vault not ready"', async () => {
    const { ctx } = await makeCtx({ provision: 'null' })
    expect(await handleAuthApprove(legacyInput, ctx)).toEqual({ ok: false, error: 'Vault not ready' })
  })

  it('provisionSiteDid throws (invalid origin) → error result', async () => {
    const { ctx } = await makeCtx({ provision: 'throw' })
    expect(await handleAuthApprove(legacyInput, ctx)).toEqual({ ok: false, error: 'Invalid origin for site DID' })
  })

  it('FAIL-CLOSED (legacy) — gate rejects → error, rawSign NEVER called', async () => {
    const gate: PresenceGate = vi.fn(async () => { throw new Error('USER_VERIFICATION_CANCELLED') })
    const { ctx, rawSign } = await makeCtx({ gate })
    const result = await handleAuthApprove(legacyInput, ctx)
    expect(result).toEqual({ ok: false, error: 'USER_VERIFICATION_CANCELLED' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('FAIL-CLOSED (cw) — gate rejects → error, rawSign NEVER called', async () => {
    const gate: PresenceGate = vi.fn(async () => { throw new Error('USER_VERIFICATION_CANCELLED') })
    const { ctx, rawSign } = await makeCtx({ gate })
    const result = await handleAuthApprove(cwInput, ctx)
    expect(result).toEqual({ ok: false, error: 'USER_VERIFICATION_CANCELLED' })
    expect(rawSign).not.toHaveBeenCalled()
  })
})

describe('AUTH keys-never-mirrored — the pairwise siteDids private key is never mirrored', () => {
  it('a vault with a siteDids private key mirrors to origin→did only, WITHOUT the key', () => {
    // Deterministic `d` I control (the provisioning adapter mirrors through this real
    // toPublicVault). A mutation that copies the full siteDids entry into the mirror
    // would leak SITE_PAIRWISE_SECRET and redden this.
    const vault = {
      did: 'did:jwk:root',
      credentials: [],
      linkedSolanaAddress: null,
      keyShares: [],
      proofRequests: [],
      preparedPresentations: [],
      linkedIdentities: [],
      siteDids: {
        'https://verifier.example': {
          did: 'did:jwk:site-alice',
          privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', d: 'SITE_PAIRWISE_SECRET' } as JsonWebKey,
          createdAt: '2026-01-01T00:00:00Z',
          lastUsedAt: '2026-01-02T00:00:00Z',
        },
      },
    } as unknown as VaultData

    const mirror = toPublicVault(vault)
    const site = mirror.siteDids!['https://verifier.example']

    expect(site).toEqual({ did: 'did:jwk:site-alice', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-02T00:00:00Z' })
    expect('privateKeyJwk' in site).toBe(false)
    expect(JSON.stringify(mirror)).not.toContain('SITE_PAIRWISE_SECRET')
  })
})
