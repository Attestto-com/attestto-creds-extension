import { describe, it, expect, beforeAll } from 'vitest'
import { publicJwkToDid, didToPublicJwk, didJwkVerificationMethod, resolveDid } from './did-jwk'

let publicJwk: JsonWebKey
let privateJwk: JsonWebKey

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
})

describe('did-jwk', () => {
  it('generates a did:jwk from a public JWK', () => {
    const did = publicJwkToDid(publicJwk)
    expect(did).toMatch(/^did:jwk:[A-Za-z0-9_-]+$/)
  })

  it('roundtrips: publicJwkToDid → didToPublicJwk', () => {
    const did = publicJwkToDid(publicJwk)
    const recovered = didToPublicJwk(did)

    expect(recovered.kty).toBe('EC')
    expect(recovered.crv).toBe('P-256')
    expect(recovered.x).toBe(publicJwk.x)
    expect(recovered.y).toBe(publicJwk.y)
  })

  it('strips private key fields from the DID', () => {
    // Pass a private JWK — should only encode public fields
    const did = publicJwkToDid(privateJwk)
    const recovered = didToPublicJwk(did)

    expect(recovered.d).toBeUndefined()
    expect(recovered.key_ops).toBeUndefined()
    expect(recovered.ext).toBeUndefined()
  })

  it('throws for non-did:jwk input', () => {
    expect(() => didToPublicJwk('did:key:z123')).toThrow('Not a did:jwk')
    expect(() => didToPublicJwk('not-a-did')).toThrow('Not a did:jwk')
  })

  it('verification method is <did>#0', () => {
    const did = publicJwkToDid(publicJwk)
    const vm = didJwkVerificationMethod(did)
    expect(vm).toBe(`${did}#0`)
  })

  it('resolves to a valid DID Document', () => {
    const did = publicJwkToDid(publicJwk)
    const doc = resolveDid(did)

    expect(doc.id).toBe(did)

    const context = doc['@context'] as string[]
    expect(context).toContain('https://www.w3.org/ns/did/v1')

    const vms = doc.verificationMethod as Array<Record<string, unknown>>
    expect(vms).toHaveLength(1)
    expect(vms[0].id).toBe(`${did}#0`)
    expect(vms[0].type).toBe('JsonWebKey2020')
    expect(vms[0].controller).toBe(did)

    const pubKey = vms[0].publicKeyJwk as JsonWebKey
    expect(pubKey.x).toBe(publicJwk.x)
    expect(pubKey.y).toBe(publicJwk.y)
  })

  it('DID Document includes authentication and assertionMethod', () => {
    const did = publicJwkToDid(publicJwk)
    const doc = resolveDid(did)
    const vm = `${did}#0`

    expect(doc.authentication).toEqual([vm])
    expect(doc.assertionMethod).toEqual([vm])
  })

  it('two different keys produce different DIDs', async () => {
    const keyPair2 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    const publicJwk2 = await crypto.subtle.exportKey('jwk', keyPair2.publicKey)

    const did1 = publicJwkToDid(publicJwk)
    const did2 = publicJwkToDid(publicJwk2)

    expect(did1).not.toBe(did2)
  })

  it('same key always produces the same DID', () => {
    const did1 = publicJwkToDid(publicJwk)
    const did2 = publicJwkToDid(publicJwk)
    expect(did1).toBe(did2)
  })

  it('produced DID can sign and verify end-to-end', async () => {
    const did = publicJwkToDid(publicJwk)
    const doc = resolveDid(did)

    // Get public key from resolved document
    const vms = doc.verificationMethod as Array<Record<string, unknown>>
    const resolvedPubJwk = vms[0].publicKeyJwk as JsonWebKey

    // Import the resolved public key
    const pubKey = await crypto.subtle.importKey(
      'jwk',
      resolvedPubJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    // Sign with the private key
    const privKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )

    const data = new TextEncoder().encode('test payload')
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privKey,
      data,
    )

    // Verify with the public key from the resolved DID Document
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      signature,
      data,
    )

    expect(valid).toBe(true)
  })
})
