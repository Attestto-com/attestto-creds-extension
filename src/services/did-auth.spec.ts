import { describe, it, expect } from 'vitest'
import { canonicalAuthMessage, signDidAuth, DID_AUTH_CANONICAL_VERSION } from './did-auth'
import { publicJwkToDid, resolveDid } from '@/utils/did-jwk'

/**
 * These tests reproduce the verifier's (`@attestto/id-wallet-adapter`
 * `verifyAuth`) trust checks locally, so a green run here proves an end-to-end
 * `requestAuth` → `verifyAuth` round-trip would return `authenticated: true`
 * for a pairwise did:jwk — without any network resolution.
 */

function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function freshPairwiseDid() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  return {
    did: publicJwkToDid(publicJwk),
    privateKeyJwk,
    publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } as JsonWebKey,
  }
}

const CHALLENGE = {
  nonce: 'srv-nonce-abc123',
  audience: 'https://verifier.example',
  origin: 'https://verifier.example',
  timestamp: '2026-07-19T12:00:00.000Z',
}

describe('canonicalAuthMessage', () => {
  it('is LF-joined with the version tag first and no trailing newline', () => {
    const msg = canonicalAuthMessage({ did: 'did:jwk:xyz', ...CHALLENGE })
    expect(msg).toBe(
      [
        'attestto-did-auth-v1',
        'did:jwk:xyz',
        'srv-nonce-abc123',
        'https://verifier.example',
        'https://verifier.example',
        '2026-07-19T12:00:00.000Z',
      ].join('\n'),
    )
    expect(msg.endsWith('\n')).toBe(false)
    expect(msg.split('\n')[0]).toBe(DID_AUTH_CANONICAL_VERSION)
  })

  it('binds the DID inside the signed payload', () => {
    const a = canonicalAuthMessage({ did: 'did:jwk:aaa', ...CHALLENGE })
    const b = canonicalAuthMessage({ did: 'did:jwk:bbb', ...CHALLENGE })
    expect(a).not.toBe(b)
  })
})

describe('signDidAuth', () => {
  it('returns a full AuthResponse echoing the challenge', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({ ...id, ...CHALLENGE })
    expect(res.approved).toBe(true)
    expect(res.did).toBe(id.did)
    expect(res.nonce).toBe(CHALLENGE.nonce)
    expect(res.audience).toBe(CHALLENGE.audience)
    expect(res.origin).toBe(CHALLENGE.origin)
    expect(res.timestamp).toBe(CHALLENGE.timestamp)
    expect(res.publicKeyJwk).toEqual(id.publicKeyJwk)
  })

  it('defaults the timestamp to an ISO 8601 string when omitted', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({
      did: id.did,
      privateKeyJwk: id.privateKeyJwk,
      publicKeyJwk: id.publicKeyJwk,
      nonce: CHALLENGE.nonce,
      audience: CHALLENGE.audience,
      origin: CHALLENGE.origin,
    })
    expect(() => new Date(res.timestamp).toISOString()).not.toThrow()
    expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp)
  })

  it('produces a raw 64-byte (IEEE-P1363) signature, not DER', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({ ...id, ...CHALLENGE })
    const bytes = base64urlToBytes(res.signature)
    expect(bytes.length).toBe(64)
    // DER-encoded ECDSA signatures start with 0x30 (SEQUENCE) — the verifier rejects those.
    expect(bytes[0]).not.toBe(0x30)
  })

  it('encodes the signature as URL-safe base64 without padding', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({ ...id, ...CHALLENGE })
    expect(res.signature).not.toMatch(/[+/=]/)
  })
})

describe('verifier round-trip (mirrors verifyAuth)', () => {
  it('signature verifies over the canonical payload with the response key', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({ ...id, ...CHALLENGE })

    const message = canonicalAuthMessage({
      did: res.did,
      nonce: res.nonce,
      audience: res.audience,
      origin: res.origin,
      timestamp: res.timestamp,
    })
    const key = await crypto.subtle.importKey(
      'jwk',
      res.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64urlToBytes(res.signature),
      new TextEncoder().encode(message),
    )
    expect(ok).toBe(true)
  })

  it('signing key resolves into the DID Document authentication relationship', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({ ...id, ...CHALLENGE })

    // What a Universal Resolver returns for the pairwise did:jwk.
    const doc = resolveDid(res.did)
    const auth = doc.authentication as string[]
    const vms = doc.verificationMethod as Array<{ id: string; publicKeyJwk: JsonWebKey }>
    const authVm = vms.find((vm) => auth.includes(vm.id))
    expect(authVm).toBeDefined()
    // The published key equals the key the wallet signed with.
    expect(authVm!.publicKeyJwk.x).toBe(res.publicKeyJwk.x)
    expect(authVm!.publicKeyJwk.y).toBe((res.publicKeyJwk as { y: string }).y)
    expect(authVm!.publicKeyJwk.crv).toBe('P-256')
  })

  it('a tampered origin breaks signature verification (replay/rebinding defense)', async () => {
    const id = await freshPairwiseDid()
    const res = await signDidAuth({ ...id, ...CHALLENGE })

    // Verifier builds the canonical from its OWN expected values; a mismatch fails.
    const tampered = canonicalAuthMessage({
      did: res.did,
      nonce: res.nonce,
      audience: res.audience,
      origin: 'https://attacker.example',
      timestamp: res.timestamp,
    })
    const key = await crypto.subtle.importKey(
      'jwk',
      res.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64urlToBytes(res.signature),
      new TextEncoder().encode(tampered),
    )
    expect(ok).toBe(false)
  })
})
