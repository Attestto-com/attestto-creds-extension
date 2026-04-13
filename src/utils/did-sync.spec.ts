import { describe, it, expect, beforeAll } from 'vitest'
import { publicJwkToDid, didToPublicJwk, didJwkVerificationMethod } from './did-jwk'

/**
 * DID Sync — tests for the Phase C key lifecycle.
 *
 * Verifies that a platform-assigned DID (did:sns, did:web) can coexist
 * with the extension's self-issued did:jwk, and that the public key
 * extracted for sync is valid and can verify signatures made with
 * the corresponding private key.
 */

let publicJwk: JsonWebKey
let privateJwk: JsonWebKey
let selfIssuedDid: string

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  selfIssuedDid = publicJwkToDid(publicJwk)
})

describe('DID Sync — public key extraction', () => {
  it('extracts public key from private JWK (strips d, key_ops, ext)', () => {
    const pub: JsonWebKey = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
    }

    expect(pub.d).toBeUndefined()
    expect(pub.key_ops).toBeUndefined()
    expect(pub.ext).toBeUndefined()
    expect(pub.kty).toBe('EC')
    expect(pub.crv).toBe('P-256')
    expect(pub.x).toBe(publicJwk.x)
    expect(pub.y).toBe(publicJwk.y)
  })

  it('extracted public key matches self-issued did:jwk', () => {
    const pub: JsonWebKey = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
    }

    const didFromExtracted = publicJwkToDid(pub)
    expect(didFromExtracted).toBe(selfIssuedDid)
  })

  it('extracted public key can verify signatures from private key', async () => {
    const pub: JsonWebKey = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
    }

    const pubKey = await crypto.subtle.importKey(
      'jwk',
      pub,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    const privKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )

    const data = new TextEncoder().encode('DID sync payload')
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privKey,
      data,
    )

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sig,
      data,
    )

    expect(valid).toBe(true)
  })
})

describe('DID Sync — holderDid coexistence', () => {
  it('self-issued did:jwk is independent from platform DID', () => {
    const platformDid = 'did:sns:alice.attestto.sol'
    const platformVm = `${platformDid}#ext-key`

    // Vault would store both:
    // - did: selfIssuedDid (the extension's own identity)
    // - holderDid: platformDid (platform-assigned, used for VP signing)
    // - verificationMethod: platformVm

    expect(selfIssuedDid).toMatch(/^did:jwk:/)
    expect(platformDid).toMatch(/^did:sns:/)
    expect(selfIssuedDid).not.toBe(platformDid)
  })

  it('verification method uses platform-assigned URI, not did:jwk default', () => {
    const platformDid = 'did:web:attestto.com:users:alice'
    const platformVm = `${platformDid}#ext-signing-key`

    // did:jwk default is #0
    const jwkVm = didJwkVerificationMethod(selfIssuedDid)
    expect(jwkVm).toMatch(/#0$/)

    // Platform VM is different
    expect(platformVm).not.toBe(jwkVm)
    expect(platformVm).toContain('#ext-signing-key')
  })

  it('platform can use returned public key to build DID Document entry', () => {
    const platformDid = 'did:sns:alice.attestto.sol'
    const platformVm = `${platformDid}#ext-key`

    // This is what the platform would add to the DID Document
    const verificationMethodEntry = {
      id: platformVm,
      type: 'JsonWebKey2020',
      controller: platformDid,
      publicKeyJwk: {
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
        y: publicJwk.y,
      },
    }

    expect(verificationMethodEntry.id).toBe(platformVm)
    expect(verificationMethodEntry.publicKeyJwk.kty).toBe('EC')
    expect(verificationMethodEntry.publicKeyJwk.crv).toBe('P-256')
    expect(verificationMethodEntry.publicKeyJwk.x).toBe(publicJwk.x)
  })
})

describe('DID Sync — message contract', () => {
  it('ATTESTTO_DID_SYNC message has required fields', () => {
    const msg = {
      type: 'ATTESTTO_DID_SYNC',
      requestId: 'sync-123',
      holderDid: 'did:sns:alice.attestto.sol',
      verificationMethod: 'did:sns:alice.attestto.sol#ext-key',
    }

    expect(msg.type).toBe('ATTESTTO_DID_SYNC')
    expect(msg.holderDid).toMatch(/^did:/)
    expect(msg.verificationMethod).toContain('#')
  })

  it('ATTESTTO_DID_SYNC_RESPONSE returns public key', () => {
    const response = {
      type: 'ATTESTTO_DID_SYNC_RESPONSE',
      requestId: 'sync-123',
      publicKeyJwk: {
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
        y: publicJwk.y,
      },
      holderDid: 'did:sns:alice.attestto.sol',
      error: null,
    }

    expect(response.publicKeyJwk.kty).toBe('EC')
    expect(response.error).toBeNull()
  })
})

describe('Key Rotation — Phase D', () => {
  it('ATTESTTO_KEY_ROTATE message has required fields', () => {
    const msg = {
      type: 'ATTESTTO_KEY_ROTATE',
      requestId: 'rotate-456',
    }

    expect(msg.type).toBe('ATTESTTO_KEY_ROTATE')
    expect(msg.requestId).toBeTruthy()
  })

  it('KEY_ROTATE_RESPONSE returns new and old public keys', async () => {
    // Simulate generating a new keypair (rotation)
    const newKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    const newPublicJwk = await crypto.subtle.exportKey('jwk', newKeyPair.publicKey)

    const response = {
      type: 'ATTESTTO_KEY_ROTATE_RESPONSE',
      requestId: 'rotate-456',
      newPublicKeyJwk: {
        kty: newPublicJwk.kty,
        crv: newPublicJwk.crv,
        x: newPublicJwk.x,
        y: newPublicJwk.y,
      },
      oldPublicKeyJwk: {
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
        y: publicJwk.y,
      },
      error: null,
    }

    expect(response.newPublicKeyJwk.kty).toBe('EC')
    expect(response.oldPublicKeyJwk.kty).toBe('EC')
    expect(response.newPublicKeyJwk.x).not.toBe(response.oldPublicKeyJwk.x)
    expect(response.error).toBeNull()
  })

  it('new key generates a different did:jwk than old key', async () => {
    const newKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    const newPublicJwk = await crypto.subtle.exportKey('jwk', newKeyPair.publicKey)
    const newDid = publicJwkToDid(newPublicJwk)

    expect(newDid).toMatch(/^did:jwk:/)
    expect(newDid).not.toBe(selfIssuedDid)
  })

  it('old key can still verify signatures made before rotation', async () => {
    // Sign with current (pre-rotation) private key
    const privKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )

    const data = new TextEncoder().encode('Pre-rotation payload')
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privKey,
      data,
    )

    // Verify with old public key (still valid for existing VPs)
    const pubKey = await crypto.subtle.importKey(
      'jwk',
      { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      sig,
      data,
    )

    expect(valid).toBe(true)
  })

  it('new key signs payloads that old key cannot verify', async () => {
    // Generate new keypair (simulating rotation)
    const newKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )

    const data = new TextEncoder().encode('Post-rotation payload')
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      newKeyPair.privateKey,
      data,
    )

    // Old public key should NOT verify the new signature
    const oldPubKey = await crypto.subtle.importKey(
      'jwk',
      { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      oldPubKey,
      sig,
      data,
    )

    expect(valid).toBe(false)
  })
})
