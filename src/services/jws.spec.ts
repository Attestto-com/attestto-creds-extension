/**
 * Story 1.11 — the compact-JWS assembly primitive (crypto-sensitive; this replaces
 * jose's `SignJWT.sign`, so it is characterized hard).
 *
 * Two load-bearing referents:
 *   - STRUCTURE + CROSS-TIE: the signer receives exactly `b64(header).b64(payload)`
 *     and the emitted JWS is `<that>.<b64(sig)>` — what is signed IS what is emitted.
 *   - CRYPTO VALIDITY (round-trip): `es256KeySigner` over a REAL generated P-256 key
 *     produces a 64-byte raw R‖S signature that `crypto.subtle.verify` ACCEPTS. This
 *     is the guard that a DER/format regression (an invalid or malleable signature)
 *     reddens — structure alone would pass a broken signer.
 */
import { describe, it, expect, vi } from 'vitest'
import { signCompactJws, es256KeySigner, base64urlBytes, base64urlJson, type JwsSigner } from './jws'

function decodeB64urlToString(seg: string): string {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return atob(pad)
}
function decodeB64urlToBytes(seg: string): Uint8Array {
  const s = decodeB64urlToString(seg)
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

describe('base64url', () => {
  it('is url-safe and unpadded', () => {
    const out = base64urlBytes(new Uint8Array([251, 255, 191, 0]))
    expect(out).not.toMatch(/[+/=]/)
  })
  it('round-trips a JSON object', () => {
    const obj = { a: 1, b: 'x' }
    expect(JSON.parse(decodeB64urlToString(base64urlJson(obj)))).toEqual(obj)
  })
})

describe('signCompactJws', () => {
  it('STRUCTURE — three dot-segments; header+payload decode to the inputs', async () => {
    const header = { alg: 'ES256', typ: 'JWT', kid: 'did:x#k' }
    const payload = { vp: { a: 1 }, nonce: 'n1', iss: 'did:x' }
    const sign: JwsSigner = vi.fn(async () => new Uint8Array([1, 2, 3, 4]))

    const jws = await signCompactJws(header, payload, sign)
    const [h, p, s] = jws.split('.')

    expect(jws.split('.')).toHaveLength(3)
    expect(JSON.parse(decodeB64urlToString(h))).toEqual(header)
    expect(JSON.parse(decodeB64urlToString(p))).toEqual(payload)
    expect(s).toBe(base64urlBytes(new Uint8Array([1, 2, 3, 4])))
  })

  it('CROSS-TIE — the signer signs EXACTLY the emitted `header.payload` bytes', async () => {
    const header = { alg: 'ES256' }
    const payload = { nonce: 'abc' }
    let received: Uint8Array | null = null
    const sign: JwsSigner = async (input) => {
      received = input
      return new Uint8Array([9])
    }
    const jws = await signCompactJws(header, payload, sign)
    const signedInput = jws.split('.').slice(0, 2).join('.')
    expect(new TextDecoder().decode(received!)).toBe(signedInput)
  })

  it('FAIL-CLOSED — a signer that throws yields no JWS', async () => {
    const sign: JwsSigner = async () => {
      throw new Error('gate rejected')
    }
    await expect(signCompactJws({ alg: 'ES256' }, { a: 1 }, sign)).rejects.toThrow('gate rejected')
  })
})

describe('es256KeySigner — CRYPTO VALIDITY (round-trip against a real P-256 key)', () => {
  it('produces a 64-byte raw R‖S signature that subtle.verify accepts', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

    const signer = es256KeySigner(privateJwk)
    const input = new TextEncoder().encode('eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ')
    const sig = await signer(input)

    expect(sig.byteLength).toBe(64) // raw R‖S, not DER (DER is ~70-72 variable)

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      sig as BufferSource,
      input,
    )
    expect(ok).toBe(true)
  })

  it('a full signCompactJws over a real key verifies end-to-end', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

    const jws = await signCompactJws({ alg: 'ES256', typ: 'JWT' }, { sub: 'did:x' }, es256KeySigner(privateJwk))
    const [h, p, s] = jws.split('.')
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      decodeB64urlToBytes(s) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`),
    )
    expect(ok).toBe(true)
  })
})
