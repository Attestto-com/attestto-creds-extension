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

import { signCompactJws, type JwsSigner } from './jws'
import { deriveDisclosedCredential } from './jsonld-disclosure'

export interface JsonLdVpOptions {
  credential: string // JSON-LD VC as JSON string
  holderDid: string
  /**
   * Signs the JWS signing input (AD-11c). In the background this is the gated
   * primitive; in the popup a local key signer. The VP builder never sees the key.
   */
  sign: JwsSigner
  nonce: string
  /**
   * Story 1.17 — the `credentialSubject` keys to disclose. Omit to present the
   * credential whole (which is what every caller used to do unconditionally).
   *
   * A strict subset produces a HOLDER-attested derivation: the issuer's proof is
   * dropped, because it no longer covers the reduced document. See
   * `jsonld-disclosure.ts` for why keeping it would be the worse option.
   */
  selectedFields?: readonly string[]
}

export interface ChapiVpOptions {
  credentials: Array<Record<string, unknown>>
  holderDid: string
  /** Signs the JWS signing input (AD-11c) — gated in background, local in popup. */
  sign: JwsSigner
  /** CHAPI challenge — maps to JWT nonce claim */
  challenge: string
  /** CHAPI domain — maps to JWT audience claim */
  domain: string
  /**
   * Verification method URI in the holder's DID Document — REQUIRED.
   *
   * SOC-174: this used to be optional, defaulting to `${holderDid}#key-1`.
   * `#key-1` is one method's convention, not a universal fragment: `did:sns`
   * §8.5 names the owner key `#solana-key`, and this wallet's own `did:jwk`
   * identities use `#0`. The default therefore produced a well-formed VP naming
   * a key the holder's DID Document does not contain, which a verifier reports
   * as an ordinary signature failure — indistinguishable from a wrong key.
   *
   * There is no case where guessing beats refusing. The wallet knows its
   * verification method whenever it is entitled to sign: `wallet.ts` sets it at
   * did:jwk creation, `did-sync.handler.ts` writes the one the platform sends.
   * If neither ran, this wallet cannot produce a verifiable presentation for
   * that DID yet, and saying so is the honest outcome.
   */
  verificationMethod: string
}

/**
 * The verification method must name a key INSIDE the holder's own document.
 *
 * Two ways it can fail to. A bare DID with no fragment names a document rather
 * than a key, leaving the verifier to pick one — the guessing this ticket
 * exists to remove. A fragment under someone else's DID points the proof at a
 * key the holder does not control.
 */
function assertVerificationMethod(verificationMethod: string, holderDid: string): void {
  const hash = verificationMethod.indexOf('#')
  if (hash < 0 || hash === verificationMethod.length - 1) {
    throw new Error(
      `verification method has no fragment: ${verificationMethod} — it names a document, not a key`,
    )
  }
  if (verificationMethod.slice(0, hash) !== holderDid) {
    throw new Error(
      `verification method does not belong to the holder: ${verificationMethod} vs ${holderDid}`,
    )
  }
}

/**
 * Create a signed JSON-LD Verifiable Presentation (Attestto proprietary format).
 *
 * The VP envelope contains the VC and is signed as a compact JWS.
 * This approach (JWT-wrapped VP) is compatible with most verifiers.
 */
export async function createJsonLdVp(options: JsonLdVpOptions): Promise<string> {
  const { credential, holderDid, sign, nonce, selectedFields } = options

  const parsed = JSON.parse(credential) as Record<string, unknown>
  // Filter BEFORE the envelope is built, so there is no window in which the
  // whole VC exists inside something about to be signed.
  let vc = parsed
  if (selectedFields) {
    const derived = deriveDisclosedCredential(parsed, selectedFields, { holderDid })
    if (!derived.ok) {
      // Refused rather than downgraded (2026-08-09). Throwing keeps the caller
      // from building a VP around a credential that would not verify; the UI
      // must prevent the user reaching here by disabling partial selection on
      // this format.
      throw new Error(
        `Partial disclosure is not supported for JSON-LD credentials (withholding: ${derived.withheld.join(', ')})`,
      )
    }
    vc = derived.credential
  }

  const vpPayload = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    holder: holderDid,
    verifiableCredential: [vc],
    nonce,
  }

  // Same claims jose emitted: the payload + setIssuedAt (iat) + setIssuer (iss).
  return signCompactJws(
    { alg: 'ES256', typ: 'JWT', kid: holderDid },
    { vp: vpPayload, nonce, iat: Math.floor(Date.now() / 1000), iss: holderDid },
    sign,
  )
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
    sign,
    challenge,
    domain,
    verificationMethod,
  } = options

  if (!verificationMethod) {
    throw new Error(
      'no verification method for this holder DID — refusing to guess a key fragment',
    )
  }
  assertVerificationMethod(verificationMethod, holderDid)
  const kid = verificationMethod

  // Build the VP envelope without proof (the "to-be-signed" document)
  const vpWithoutProof = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    holder: holderDid,
    verifiableCredential: credentials,
  }

  // Sign the VP as a JWT — verifiers can check this via the resolver's /1.0/verify
  // endpoint. Same claims jose emitted: payload + iat + iss + aud.
  const jws = await signCompactJws(
    { alg: 'ES256', typ: 'JWT', kid },
    { vp: vpWithoutProof, nonce: challenge, iat: Math.floor(Date.now() / 1000), iss: holderDid, aud: domain },
    sign,
  )

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
