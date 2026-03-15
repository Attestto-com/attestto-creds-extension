/**
 * JSON-LD Verifiable Presentation generation.
 *
 * Wraps VCs in a VP envelope per W3C VC Data Model 2.0,
 * signs as JWS with jose (ECDSA P-256).
 *
 * Supports two modes:
 * - **Attestto proprietary**: nonce-based VP (legacy)
 * - **CHAPI standard**: challenge/domain-based VP for interop with
 *   credential-wallet-connector's verifyPresentation()
 */

import { SignJWT, importJWK } from 'jose'

export interface JsonLdVpOptions {
  credential: string // JSON-LD VC as JSON string
  holderDid: string
  holderPrivateKey: JsonWebKey
  nonce: string
}

export interface ChapiVpOptions {
  credentials: Array<Record<string, unknown>>
  holderDid: string
  holderPrivateKey: JsonWebKey
  /** CHAPI challenge — maps to JWT nonce claim */
  challenge: string
  /** CHAPI domain — maps to JWT audience claim */
  domain: string
  /** Verification method URI in the holder's DID Document */
  verificationMethod?: string
}

/**
 * Create a signed JSON-LD Verifiable Presentation (Attestto proprietary format).
 *
 * The VP envelope contains the VC and is signed as a compact JWS.
 * This approach (JWT-wrapped VP) is compatible with most verifiers.
 */
export async function createJsonLdVp(options: JsonLdVpOptions): Promise<string> {
  const { credential, holderDid, holderPrivateKey, nonce } = options

  const vc = JSON.parse(credential) as Record<string, unknown>

  const vpPayload = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    holder: holderDid,
    verifiableCredential: [vc],
    nonce,
  }

  const privateKey = await importJWK(holderPrivateKey, 'ES256')

  const jwt = await new SignJWT({ vp: vpPayload, nonce })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: holderDid })
    .setIssuedAt()
    .setIssuer(holderDid)
    .sign(privateKey)

  return jwt
}

/**
 * Create a signed W3C Verifiable Presentation for CHAPI interop.
 *
 * Returns a JSON object (not a JWT string) with an embedded proof,
 * compatible with credential-wallet-connector's verifyPresentation().
 *
 * The VP includes:
 * - `holder` — the user's DID (extracted by verifiers)
 * - `verifiableCredential` — array of VCs
 * - `proof` — EcdsaSecp256r1Signature2019 with challenge/domain
 */
export async function createChapiVp(options: ChapiVpOptions): Promise<Record<string, unknown>> {
  const {
    credentials,
    holderDid,
    holderPrivateKey,
    challenge,
    domain,
    verificationMethod,
  } = options

  const kid = verificationMethod ?? `${holderDid}#key-1`

  // Build the VP envelope without proof (the "to-be-signed" document)
  const vpWithoutProof = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    holder: holderDid,
    verifiableCredential: credentials,
  }

  // Sign the VP as a JWT — verifiers can check this via the resolver's /1.0/verify endpoint
  const privateKey = await importJWK(holderPrivateKey, 'ES256')

  const jws = await new SignJWT({ vp: vpWithoutProof, nonce: challenge })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
    .setIssuedAt()
    .setIssuer(holderDid)
    .setAudience(domain)
    .sign(privateKey)

  // Return the full VP with embedded proof
  return {
    ...vpWithoutProof,
    proof: {
      type: 'EcdsaSecp256r1Signature2019',
      created: new Date().toISOString(),
      challenge,
      domain,
      verificationMethod: kid,
      jws,
    },
  }
}
