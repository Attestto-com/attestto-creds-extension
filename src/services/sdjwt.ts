/**
 * SD-JWT parsing, disclosure decoding, and presentation generation.
 *
 * Uses @sd-jwt/decode for parsing and jose for Key Binding JWT signing.
 */

import { decodeSdJwt, getClaims } from '@sd-jwt/decode'
import { present } from '@sd-jwt/present'
import { SignJWT, importJWK } from 'jose'
import type { Disclosure } from '@sd-jwt/types'

export interface ParsedSdJwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  disclosures: Disclosure[]
  keyBindingJwt: string | undefined
}

export interface DecodedDisclosure {
  salt: string
  claimName: string
  claimValue: unknown
}

/**
 * SHA-256 hasher for @sd-jwt libraries.
 */
async function sha256Hasher(data: string | ArrayBuffer): Promise<Uint8Array> {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', input)
  return new Uint8Array(digest)
}

/**
 * Parse an SD-JWT compact serialization string.
 */
export async function parseSdJwt(compact: string): Promise<ParsedSdJwt> {
  const decoded = await decodeSdJwt(compact, sha256Hasher)

  return {
    header: decoded.jwt.header as Record<string, unknown>,
    payload: decoded.jwt.payload as Record<string, unknown>,
    disclosures: decoded.disclosures,
    keyBindingJwt: undefined,
  }
}

/**
 * Get all decoded claims (issuer payload + selectively disclosed claims merged).
 */
export async function getDecodedClaims(
  compact: string,
): Promise<Record<string, unknown>> {
  const claims = await getClaims<Record<string, unknown>>(
    compact,
    sha256Hasher,
    async (data) => data,
  )
  return claims
}

/**
 * Decode raw disclosures into structured objects.
 */
export function decodeDisclosures(disclosures: Disclosure[]): DecodedDisclosure[] {
  return disclosures.map((d) => ({
    salt: d.salt ?? '',
    claimName: d.key ?? '',
    claimValue: d.value,
  }))
}

/**
 * Create an SD-JWT presentation with selective disclosure.
 *
 * @param compact - Original SD-JWT compact string
 * @param selectedClaimNames - Claim names to include in the presentation
 * @param holderPrivateKey - Holder's ECDSA P-256 private key (JWK)
 * @param nonce - Verifier-provided nonce for Key Binding JWT
 * @param audience - Verifier identifier (aud claim in KB-JWT)
 */
export async function createSdJwtPresentation(
  compact: string,
  selectedClaimNames: string[],
  holderPrivateKey: JsonWebKey,
  nonce: string,
  audience: string,
): Promise<string> {
  // Build presentation frame: { claimName: true } for each selected claim
  const frame: Record<string, boolean> = {}
  for (const name of selectedClaimNames) {
    frame[name] = true
  }

  // Create the presentation (SD-JWT with only selected disclosures)
  const presentation = await present(compact, frame, sha256Hasher)

  // Create and append Key Binding JWT
  const privateKey = await importJWK(holderPrivateKey, 'ES256')
  const kbJwt = await new SignJWT({ nonce, aud: audience, iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: 'ES256', typ: 'kb+jwt' })
    .sign(privateKey)

  return `${presentation}${kbJwt}`
}
