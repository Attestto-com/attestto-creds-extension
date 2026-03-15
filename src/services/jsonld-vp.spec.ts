import { describe, it, expect, beforeAll } from 'vitest'
import { createJsonLdVp, createChapiVp } from './jsonld-vp'
import { decodeJwt, decodeProtectedHeader } from 'jose'

let testPrivateKey: JsonWebKey
let testDid: string

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  testPrivateKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  testDid = 'did:key:zTestHolder123'
})

const sampleVc = JSON.stringify({
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential', 'KycCredential'],
  issuer: 'did:key:zIssuer456',
  issuanceDate: '2026-01-15T00:00:00Z',
  credentialSubject: {
    id: 'did:key:zSubject789',
    name: 'Alice Smith',
    nationality: 'CR',
  },
})

const sampleVcParsed = JSON.parse(sampleVc) as Record<string, unknown>

describe('jsonld-vp service', () => {
  it('creates a valid signed JWT VP', async () => {
    const vp = await createJsonLdVp({
      credential: sampleVc,
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      nonce: 'test-nonce-123',
    })

    expect(vp).toBeTypeOf('string')
    // JWT format: header.payload.signature
    const parts = vp.split('.')
    expect(parts).toHaveLength(3)
  })

  it('includes nonce in the VP payload', async () => {
    const vp = await createJsonLdVp({
      credential: sampleVc,
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      nonce: 'nonce-abc',
    })

    const payload = decodeJwt(vp)
    expect(payload.nonce).toBe('nonce-abc')
  })

  it('sets holder DID as issuer and kid', async () => {
    const vp = await createJsonLdVp({
      credential: sampleVc,
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      nonce: 'nonce-456',
    })

    const header = decodeProtectedHeader(vp)
    const payload = decodeJwt(vp)

    expect(header.kid).toBe(testDid)
    expect(header.alg).toBe('ES256')
    expect(payload.iss).toBe(testDid)
  })

  it('embeds the VC inside the VP envelope', async () => {
    const vp = await createJsonLdVp({
      credential: sampleVc,
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      nonce: 'nonce-789',
    })

    const payload = decodeJwt(vp) as Record<string, unknown>
    const vpData = payload.vp as Record<string, unknown>

    expect(vpData.type).toContain('VerifiablePresentation')
    expect(vpData.holder).toBe(testDid)
    expect(vpData.verifiableCredential).toHaveLength(1)
  })

  it('includes the correct @context', async () => {
    const vp = await createJsonLdVp({
      credential: sampleVc,
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      nonce: 'nonce-ctx',
    })

    const payload = decodeJwt(vp) as Record<string, unknown>
    const vpData = payload.vp as Record<string, unknown>
    const context = vpData['@context'] as string[]

    expect(context).toContain('https://www.w3.org/2018/credentials/v1')
  })
})

describe('createChapiVp — CHAPI standard VP', () => {
  it('returns a JSON object with W3C VP structure', async () => {
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'chapi-challenge-123',
      domain: 'https://verifier.example.com',
    })

    expect(vp).toBeTypeOf('object')
    expect(vp['@context']).toContain('https://www.w3.org/2018/credentials/v1')
    expect(vp.type).toContain('VerifiablePresentation')
  })

  it('sets holder DID in the VP', async () => {
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-holder',
      domain: 'https://example.com',
    })

    expect(vp.holder).toBe(testDid)
  })

  it('includes challenge and domain in the proof', async () => {
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-xyz',
      domain: 'https://verifier.example.com',
    })

    const proof = vp.proof as Record<string, unknown>
    expect(proof.challenge).toBe('challenge-xyz')
    expect(proof.domain).toBe('https://verifier.example.com')
    expect(proof.type).toBe('EcdsaSecp256r1Signature2019')
  })

  it('includes a JWS signature in the proof', async () => {
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-sig',
      domain: 'https://example.com',
    })

    const proof = vp.proof as Record<string, unknown>
    expect(proof.jws).toBeTypeOf('string')
    // JWS has 3 dot-separated parts
    const parts = (proof.jws as string).split('.')
    expect(parts).toHaveLength(3)
  })

  it('uses default verificationMethod when not specified', async () => {
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-vm',
      domain: 'https://example.com',
    })

    const proof = vp.proof as Record<string, unknown>
    expect(proof.verificationMethod).toBe(`${testDid}#key-1`)
  })

  it('uses custom verificationMethod when specified', async () => {
    const customVm = `${testDid}#signing-key-2`
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-custom-vm',
      domain: 'https://example.com',
      verificationMethod: customVm,
    })

    const proof = vp.proof as Record<string, unknown>
    expect(proof.verificationMethod).toBe(customVm)
  })

  it('embeds credentials in the VP', async () => {
    const vp = await createChapiVp({
      credentials: [sampleVcParsed],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-creds',
      domain: 'https://example.com',
    })

    const creds = vp.verifiableCredential as unknown[]
    expect(creds).toHaveLength(1)
    expect((creds[0] as Record<string, unknown>).issuer).toBe('did:key:zIssuer456')
  })

  it('supports empty credentials array (DIDAuthentication)', async () => {
    const vp = await createChapiVp({
      credentials: [],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-auth-only',
      domain: 'https://example.com',
    })

    expect(vp.holder).toBe(testDid)
    expect(vp.verifiableCredential).toEqual([])
    expect(vp.proof).toBeDefined()
  })

  it('sets audience in the JWS to match domain', async () => {
    const vp = await createChapiVp({
      credentials: [],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-aud',
      domain: 'https://myapp.example.com',
    })

    const proof = vp.proof as Record<string, unknown>
    const jwt = decodeJwt(proof.jws as string)
    expect(jwt.aud).toBe('https://myapp.example.com')
  })

  it('sets issuer in the JWS to holder DID', async () => {
    const vp = await createChapiVp({
      credentials: [],
      holderDid: testDid,
      holderPrivateKey: testPrivateKey,
      challenge: 'challenge-iss',
      domain: 'https://example.com',
    })

    const proof = vp.proof as Record<string, unknown>
    const jwt = decodeJwt(proof.jws as string)
    expect(jwt.iss).toBe(testDid)
  })
})
