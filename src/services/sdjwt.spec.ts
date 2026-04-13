import { describe, it, expect, beforeEach } from 'vitest'
import * as jose from 'jose'

let testPrivateKey: JsonWebKey

beforeEach(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  testPrivateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
})

/**
 * Base64url encode (no padding).
 */
function b64url(input: string | Uint8Array): string {
  const str = typeof input === 'string'
    ? btoa(input)
    : btoa(String.fromCharCode(...input))
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * SHA-256 hash, returned as Uint8Array.
 */
async function sha256(data: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(data)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
}

/**
 * Create a properly structured SD-JWT with matching disclosure hashes.
 */
async function createTestSdJwt(): Promise<string> {
  const privateKey = await jose.importJWK(testPrivateKey, 'ES256')

  // Create disclosures as base64url-encoded JSON arrays: [salt, claim_name, value]
  const disc1Raw = JSON.stringify(['salt1', 'given_name', 'Alice'])
  const disc1B64 = b64url(disc1Raw)
  const disc2Raw = JSON.stringify(['salt2', 'family_name', 'Smith'])
  const disc2B64 = b64url(disc2Raw)

  // Compute SHA-256 digests of the base64url disclosures (this is how SD-JWT works)
  const hash1 = b64url(await sha256(disc1B64))
  const hash2 = b64url(await sha256(disc2B64))

  // Create issuer JWT with _sd array containing the disclosure hashes
  const jwt = await new jose.SignJWT({
    iss: 'https://issuer.example.com',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    vct: ['VerifiableCredential', 'IdentityCredential'],
    _sd: [hash1, hash2],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'vc+sd-jwt' })
    .sign(privateKey)

  return `${jwt}~${disc1B64}~${disc2B64}~`
}

describe('sdjwt service', () => {
  describe('parseSdJwt', () => {
    it('parses a valid SD-JWT compact string', async () => {
      const { parseSdJwt } = await import('./sdjwt')
      const compact = await createTestSdJwt()
      const result = await parseSdJwt(compact)

      expect(result.header).toHaveProperty('alg', 'ES256')
      expect(result.payload).toHaveProperty('iss', 'https://issuer.example.com')
      expect(result.disclosures).toHaveLength(2)
    })

    it('extracts the correct issuer and timestamps', async () => {
      const { parseSdJwt } = await import('./sdjwt')
      const compact = await createTestSdJwt()
      const result = await parseSdJwt(compact)

      expect(result.payload.iss).toBe('https://issuer.example.com')
      expect(result.payload.iat).toBeTypeOf('number')
      expect(result.payload.exp).toBeTypeOf('number')
    })
  })

  describe('decodeDisclosures', () => {
    it('decodes disclosure arrays into structured objects', async () => {
      const { parseSdJwt, decodeDisclosures } = await import('./sdjwt')
      const compact = await createTestSdJwt()
      const parsed = await parseSdJwt(compact)
      const decoded = decodeDisclosures(parsed.disclosures)

      expect(decoded).toHaveLength(2)
      expect(decoded[0]).toMatchObject({
        claimName: 'given_name',
        claimValue: 'Alice',
      })
      expect(decoded[1]).toMatchObject({
        claimName: 'family_name',
        claimValue: 'Smith',
      })
    })
  })

  describe('createSdJwtPresentation', () => {
    it('creates a presentation with selected disclosures and key binding JWT', async () => {
      const { createSdJwtPresentation } = await import('./sdjwt')
      const compact = await createTestSdJwt()

      const presentation = await createSdJwtPresentation(
        compact,
        ['given_name'],
        testPrivateKey,
        'test-nonce-123',
        'https://verifier.example.com',
      )

      expect(presentation).toBeTypeOf('string')
      expect(presentation.length).toBeGreaterThan(0)
      // Should have the issuer JWT + at least one disclosure + KB-JWT
      const parts = presentation.split('~').filter(Boolean)
      expect(parts.length).toBeGreaterThanOrEqual(2)
    })

    it('includes nonce and audience in key binding JWT', async () => {
      const { createSdJwtPresentation } = await import('./sdjwt')
      const compact = await createTestSdJwt()

      const presentation = await createSdJwtPresentation(
        compact,
        ['given_name'],
        testPrivateKey,
        'nonce-abc',
        'aud-xyz',
      )

      // The last non-empty segment should be the KB-JWT (a proper JWT with 3 dots)
      const segments = presentation.split('~').filter(Boolean)
      const kbJwt = segments[segments.length - 1]
      // KB-JWT is a proper JWT with header.payload.signature
      expect(kbJwt.split('.')).toHaveLength(3)

      const kbPayload = jose.decodeJwt(kbJwt)
      expect(kbPayload.nonce).toBe('nonce-abc')
      expect(kbPayload.aud).toBe('aud-xyz')
    })
  })
})
