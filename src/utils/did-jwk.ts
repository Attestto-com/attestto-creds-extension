/**
 * did:jwk — self-resolving DID method.
 *
 * The DID encodes the full public JWK as base64url, so any resolver can
 * reconstruct the DID Document without a network call.
 *
 * Spec: https://github.com/quartzjer/did-jwk/blob/main/spec.md
 *
 * Format: did:jwk:<base64url(JSON(publicJwk))>
 *
 * The resolved DID Document contains a single verificationMethod with the
 * public key, and lists it in assertionMethod + authentication.
 */

// --------------------------------------------------------------------------
// Base64url helpers (no padding, URL-safe alphabet)
// --------------------------------------------------------------------------

function base64urlEncode(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (str.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

// --------------------------------------------------------------------------
// DID generation
// --------------------------------------------------------------------------

/**
 * Generate a `did:jwk` from an ECDSA P-256 public key JWK.
 *
 * Strips the private key fields (`d`, `key_ops`, `ext`) and encodes
 * only the public components (`kty`, `crv`, `x`, `y`).
 */
export function publicJwkToDid(publicJwk: JsonWebKey): string {
  // Only include public key fields per did:jwk spec
  const pub: Record<string, string> = {
    kty: publicJwk.kty!,
    crv: publicJwk.crv!,
    x: publicJwk.x!,
    y: publicJwk.y!,
  }
  const json = JSON.stringify(pub)
  const encoded = base64urlEncode(new TextEncoder().encode(json))
  return `did:jwk:${encoded}`
}

/**
 * Extract the public JWK from a `did:jwk` string.
 */
export function didToPublicJwk(did: string): JsonWebKey {
  const prefix = 'did:jwk:'
  if (!did.startsWith(prefix)) {
    throw new Error(`Not a did:jwk: ${did}`)
  }
  const encoded = did.slice(prefix.length)
  const json = new TextDecoder().decode(base64urlDecode(encoded))
  return JSON.parse(json) as JsonWebKey
}

/**
 * Build the canonical verification method ID for a did:jwk.
 *
 * Per spec, the single verification method is `<did>#0`.
 */
export function didJwkVerificationMethod(did: string): string {
  return `${did}#0`
}

/**
 * Resolve a `did:jwk` to its DID Document (no network call needed).
 *
 * This is what a Universal Resolver would return for any did:jwk.
 */
export function resolveDid(did: string): Record<string, unknown> {
  const publicJwk = didToPublicJwk(did)
  const vm = didJwkVerificationMethod(did)

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/jws-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: vm,
        type: 'JsonWebKey2020',
        controller: did,
        publicKeyJwk: publicJwk,
      },
    ],
    authentication: [vm],
    assertionMethod: [vm],
  }
}
