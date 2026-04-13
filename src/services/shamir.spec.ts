import { describe, it, expect } from 'vitest'
import { splitKey, combineShares, split2of3, combine2of3, toBase64Url, fromBase64Url } from './shamir'

describe('Shamir Secret Sharing (2-of-2 XOR)', () => {
  it('splits a key into two shares', () => {
    const key = new Uint8Array(32)
    crypto.getRandomValues(key)

    const [shareA, shareB] = splitKey(key)

    expect(shareA.length).toBe(32)
    expect(shareB.length).toBe(32)
    // Shares should not equal the original key
    expect(shareA).not.toEqual(key)
    expect(shareB).not.toEqual(key)
  })

  it('reconstructs the original key from both shares', () => {
    const key = new Uint8Array(32)
    crypto.getRandomValues(key)

    const [shareA, shareB] = splitKey(key)
    const reconstructed = combineShares(shareA, shareB)

    expect(reconstructed).toEqual(key)
  })

  it('single share alone cannot reconstruct the key', () => {
    const key = new Uint8Array(32)
    crypto.getRandomValues(key)

    const [shareA] = splitKey(key)

    // shareA alone XORed with zeros is just shareA
    const zeros = new Uint8Array(32)
    const wrong = combineShares(shareA, zeros)
    expect(wrong).not.toEqual(key)
  })

  it('throws on mismatched share lengths', () => {
    const a = new Uint8Array(32)
    const b = new Uint8Array(16)

    expect(() => combineShares(a, b)).toThrow('Share length mismatch')
  })

  it('works with various key sizes (16, 32, 64 bytes)', () => {
    for (const size of [16, 32, 64]) {
      const key = new Uint8Array(size)
      crypto.getRandomValues(key)

      const [shareA, shareB] = splitKey(key)
      const reconstructed = combineShares(shareA, shareB)

      expect(reconstructed).toEqual(key)
    }
  })

  it('produces different shares each time (random shareA)', () => {
    const key = new Uint8Array(32)
    crypto.getRandomValues(key)

    const [shareA1] = splitKey(key)
    const [shareA2] = splitKey(key)

    // Extremely unlikely to be equal
    expect(shareA1).not.toEqual(shareA2)
  })
})

describe('Shamir Secret Sharing (2-of-3 GF(256)) — Phase E', () => {
  it('splits a secret into 3 shares', () => {
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)

    const [s1, s2, s3] = split2of3(secret)

    expect(s1.length).toBe(32)
    expect(s2.length).toBe(32)
    expect(s3.length).toBe(32)
  })

  it('reconstructs from shares 1+2', () => {
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)

    const [s1, s2] = split2of3(secret)
    const reconstructed = combine2of3(
      { data: s1, index: 1 },
      { data: s2, index: 2 },
    )

    expect(reconstructed).toEqual(secret)
  })

  it('reconstructs from shares 1+3', () => {
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)

    const [s1, , s3] = split2of3(secret)
    const reconstructed = combine2of3(
      { data: s1, index: 1 },
      { data: s3, index: 3 },
    )

    expect(reconstructed).toEqual(secret)
  })

  it('reconstructs from shares 2+3', () => {
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)

    const [, s2, s3] = split2of3(secret)
    const reconstructed = combine2of3(
      { data: s2, index: 2 },
      { data: s3, index: 3 },
    )

    expect(reconstructed).toEqual(secret)
  })

  it('single share alone cannot reconstruct the secret', () => {
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)

    const [s1] = split2of3(secret)
    // Using share with zeros would give wrong result
    expect(s1).not.toEqual(secret)
  })

  it('works with JWK-sized payloads (private key backup)', () => {
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: 'N2Kp0-SY5c0HwO3fXmKdV1VN4YCKHfKxpr4GBWH1HJI',
      y: 'q7mS5IwxjmxRjEBXlwdOZsGfdgGiwPm6x0JnrmJYqMI',
      d: 'PRIVATE_KEY_MATERIAL_BASE64URL_ENCODED',
    }
    const keyBytes = new TextEncoder().encode(JSON.stringify(jwk))

    const [s1, s2, s3] = split2of3(keyBytes)

    // All 3 combinations work
    const r12 = combine2of3({ data: s1, index: 1 }, { data: s2, index: 2 })
    const r13 = combine2of3({ data: s1, index: 1 }, { data: s3, index: 3 })
    const r23 = combine2of3({ data: s2, index: 2 }, { data: s3, index: 3 })

    expect(new TextDecoder().decode(r12)).toBe(JSON.stringify(jwk))
    expect(new TextDecoder().decode(r13)).toBe(JSON.stringify(jwk))
    expect(new TextDecoder().decode(r23)).toBe(JSON.stringify(jwk))
  })

  it('throws on mismatched share lengths', () => {
    expect(() => combine2of3(
      { data: new Uint8Array(32), index: 1 },
      { data: new Uint8Array(16), index: 2 },
    )).toThrow('Share length mismatch')
  })

  it('throws on duplicate share indices', () => {
    expect(() => combine2of3(
      { data: new Uint8Array(32), index: 1 },
      { data: new Uint8Array(32), index: 1 },
    )).toThrow('Cannot reconstruct from two identical share indices')
  })

  it('throws on invalid share index', () => {
    expect(() => combine2of3(
      { data: new Uint8Array(32), index: 0 },
      { data: new Uint8Array(32), index: 2 },
    )).toThrow('Share index must be 1, 2, or 3')
  })

  it('roundtrips through base64url encoding', () => {
    const secret = new Uint8Array(48)
    crypto.getRandomValues(secret)

    const [s1, s2] = split2of3(secret)

    // Encode shares to base64url (as they would be transmitted)
    const s1Encoded = toBase64Url(s1)
    const s2Encoded = toBase64Url(s2)

    // Decode back
    const s1Decoded = fromBase64Url(s1Encoded)
    const s2Decoded = fromBase64Url(s2Encoded)

    const reconstructed = combine2of3(
      { data: s1Decoded, index: 1 },
      { data: s2Decoded, index: 2 },
    )

    expect(reconstructed).toEqual(secret)
  })

  it('produces different shares each time (random polynomial)', () => {
    const secret = new Uint8Array(32)
    crypto.getRandomValues(secret)

    const [s1a] = split2of3(secret)
    const [s1b] = split2of3(secret)

    // Extremely unlikely to be equal
    expect(s1a).not.toEqual(s1b)
  })
})

describe('Base64url encoding', () => {
  it('roundtrips Uint8Array through base64url', () => {
    const data = new Uint8Array([0, 1, 2, 255, 128, 64, 32])
    const encoded = toBase64Url(data)
    const decoded = fromBase64Url(encoded)

    expect(decoded).toEqual(data)
  })

  it('produces URL-safe characters (no +, /, or =)', () => {
    const data = new Uint8Array(48)
    crypto.getRandomValues(data)

    const encoded = toBase64Url(data)

    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
  })

  it('handles empty input', () => {
    const data = new Uint8Array(0)
    const encoded = toBase64Url(data)
    const decoded = fromBase64Url(encoded)

    expect(decoded).toEqual(data)
  })
})
