import { describe, it, expect } from 'vitest'
import { importJWK, jwtVerify, type JWTPayload } from 'jose'
import { buildPresentationResponse } from './oid4vp-presentation'
import { es256KeySigner } from '@/services/jws'
import type { AuthorizationRequest } from './oid4vp-request'

/**
 * Story 2.5 — the presentation is verified by an implementation we did not write.
 *
 * The acceptance criterion is the point of the story: a self-authored verifier
 * FAILS it. If our decoder and our encoder are the same author, agreement
 * between them is a tautology — it proves the two halves of one belief are
 * consistent, not that the artefact is valid. Every prior instance of the
 * recurring defect in this repo has that exact shape.
 *
 * So the referent here is `jose`:
 *
 *   - We deliberately do NOT sign with jose. `services/jws.ts` hand-builds the
 *     compact JWS so the signature can be routed through the background's one
 *     gated primitive (AD-11c), and `es256KeySigner` emits raw R‖S bytes from
 *     WebCrypto. jose's verifier has never seen that code path.
 *   - The key is NOT taken from our `didToPublicJwk`. This file decodes the
 *     `did:jwk` with plain base64url + JSON.parse, the way an outside verifier
 *     with only the token would have to. Reusing our decoder would smuggle the
 *     self-authorship back in through the key.
 *
 * What is still NOT covered, stated rather than implied: no live third-party
 * verifier SERVICE has accepted this token, and the ISSUER proof inside the
 * credential is not checked here (that is the issuer's suite, not ours). This
 * file proves the holder binding — signature, audience, replay nonce — against
 * an independent implementation. It does not prove end-to-end interop with a
 * deployed verifier.
 */

const CLIENT = 'did:web:verifier.example.org'

const REQUEST_BASE = {
  clientId: CLIENT,
  clientIdScheme: 'did',
  responseMode: 'direct_post',
  responseUri: 'https://verifier.example.org/present',
  nonce: 'nonce-0123456789abcdef',
  state: 'state-xyz',
  requestedClaims: ['$.credentialSubject.name'],
  verified: false,
} satisfies Omit<AuthorizationRequest, never>

/**
 * A holder key generated for real — not a fixture. The private half signs, the
 * public half is what the DID carries and what jose is handed.
 */
async function makeHolder() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey))
  const pub = { kty: publicJwk.kty!, crv: publicJwk.crv!, x: publicJwk.x!, y: publicJwk.y! }
  const did = `did:jwk:${b64url(JSON.stringify(pub))}`
  return { did, privateJwk, sign: es256KeySigner(privateJwk) }
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode `did:jwk` the way an outside verifier must: from the DID string alone,
 * with no help from this codebase's did-jwk module.
 */
function publicJwkFromDidIndependently(did: string): JsonWebKey {
  const encoded = did.slice('did:jwk:'.length)
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return JSON.parse(json) as JsonWebKey
}

/** The whole outside-verifier job: DID in, verified claims out. jose does the crypto. */
async function verifyAsThirdParty(
  vpToken: string,
  holderDid: string,
  opts: { audience: string },
): Promise<JWTPayload> {
  const key = await importJWK(publicJwkFromDidIndependently(holderDid), 'ES256')
  const { payload } = await jwtVerify(vpToken, key, {
    audience: opts.audience,
    issuer: holderDid,
  })
  return payload
}

const CREDENTIAL = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  issuer: 'did:web:issuer.example.org',
  credentialSubject: { id: 'holder', name: 'A. Person' },
  proof: { type: 'Ed25519Signature2020', jws: 'issuer-sig' },
}

async function buildToken(overrides: Partial<AuthorizationRequest> = {}) {
  const holder = await makeHolder()
  const request = { ...REQUEST_BASE, ...overrides } as AuthorizationRequest
  const result = await buildPresentationResponse({
    request,
    approvedClaims: request.requestedClaims.slice(),
    credential: { ...CREDENTIAL, credentialSubject: { id: holder.did, name: 'A. Person' } },
    holderDid: holder.did,
    holderVerificationMethod: `${holder.did}#0`,
    sign: holder.sign,
  })
  if (!result.ok) throw new Error(`build failed: ${result.reason}`)
  return { holder, request, body: result.value }
}

describe('Story 2.5 — an independent verifier accepts our presentation', () => {
  it('jose verifies the vp_token against the key carried by the holder DID', async () => {
    const { holder, body } = await buildToken()

    const payload = await verifyAsThirdParty(body.vp_token, holder.did, { audience: CLIENT })

    expect(payload.iss).toBe(holder.did)
    expect(payload.vp).toBeDefined()
  })

  it('the replay binding survives the round trip — jose reads our nonce and aud', async () => {
    const { holder, request, body } = await buildToken()

    const payload = await verifyAsThirdParty(body.vp_token, holder.did, { audience: CLIENT })

    // Both INSIDE the signature. A verifier that reads them off the POST body
    // instead would be reading unauthenticated data.
    expect(payload.nonce).toBe(request.nonce)
    expect(payload.aud).toBe(request.clientId)
  })

  it('the header names the key, so a multi-key holder is still verifiable', async () => {
    const { holder, body } = await buildToken()

    const header = JSON.parse(
      atob(body.vp_token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>

    // `did:jwk` hides this problem: the DID *is* the key, so `iss` alone is
    // enough. Any other holder method — did:web, did:sns — resolves to a
    // document with N verification methods and no way to pick one. An outside
    // verifier needs `kid` to know which key signed.
    expect(header.kid).toBe(`${holder.did}#0`)
    expect(header.alg).toBe('ES256')
  })
})

/**
 * The negative controls. Without these, the three tests above pass for a
 * verifier that accepts everything, and this file would assert nothing — the
 * failure mode that put "a green test whose colour you cannot explain is not
 * evidence" in this repo's rules.
 */
describe('Story 2.5 — and rejects what it should', () => {
  it('a tampered payload is rejected', async () => {
    const { holder, body } = await buildToken()
    const [h, p, s] = body.vp_token.split('.')
    const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
      string,
      unknown
    >
    payload.nonce = 'a-different-nonce'
    const forged = `${h}.${b64url(JSON.stringify(payload))}.${s}`

    await expect(
      verifyAsThirdParty(forged, holder.did, { audience: CLIENT }),
    ).rejects.toThrow()
  })

  it('a token signed by a different key is rejected', async () => {
    const { body } = await buildToken()
    const impostor = await makeHolder()

    // Same token, verified against someone else's DID — the shape a stolen
    // presentation replayed under another identity would have.
    await expect(
      verifyAsThirdParty(body.vp_token, impostor.did, { audience: CLIENT }),
    ).rejects.toThrow()
  })

  it('a presentation minted for another verifier is rejected', async () => {
    const { holder, body } = await buildToken()

    await expect(
      verifyAsThirdParty(body.vp_token, holder.did, {
        audience: 'did:web:someone-else.example.org',
      }),
    ).rejects.toThrow()
  })
})
