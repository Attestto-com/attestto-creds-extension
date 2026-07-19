/**
 * DID-auth signing — the wallet side of the `credential-wallet:auth` login flow.
 *
 * This is the counterpart to the verifier (`verifyAuth`) shipped in
 * `@attestto/id-wallet-adapter`. A verifying site calls `requestAuth`, which
 * dispatches a `credential-wallet:auth` event; the wallet signs a canonical,
 * versioned payload and returns an `AuthResponse`. The verifier then:
 *   1. checks the response echoes its issued nonce / audience / origin,
 *   2. verifies the signature over the SAME canonical payload,
 *   3. resolves the DID and confirms the signing key is in `authentication`,
 *   4. checks freshness + single-use.
 *
 * The signed payload MUST be byte-identical to the adapter's
 * `canonicalAuthMessage`, and the signature MUST be a raw fixed-length
 * (IEEE-P1363 r‖s for P-256, or Ed25519) value, base64url-encoded — a
 * DER-encoded ECDSA signature makes the verifier's `subtle.verify` silently
 * fail. WebCrypto's `ECDSA` sign already emits raw r‖s, so no re-encoding is
 * needed; we only base64url the bytes.
 */

/** Version tag prefixed to the signed payload so signatures cannot be replayed across protocol revisions. Must match the adapter. */
export const DID_AUTH_CANONICAL_VERSION = 'attestto-did-auth-v1'

/**
 * The wallet's authentication result, mirroring the adapter's `AuthResponse`.
 * `approved` alone is NOT proof — the verifier re-derives trust from the
 * signature + DID resolution.
 */
export interface WalletAuthResponse {
  approved: boolean
  did: string
  nonce: string
  audience: string
  origin: string
  /** Base64url of the raw signature (P-256 IEEE-P1363 r‖s, 64 bytes). */
  signature: string
  publicKeyJwk: JsonWebKey
  /** ISO 8601 timestamp the signature was created. */
  timestamp: string
}

export interface SignDidAuthParams {
  did: string
  nonce: string
  audience: string
  origin: string
  /** The P-256 private key that signs on behalf of `did`. */
  privateKeyJwk: JsonWebKey
  /** The public half published for the verifier (must resolve into the DID's `authentication`). */
  publicKeyJwk: JsonWebKey
  /** ISO 8601 timestamp; defaults to now. Injectable for deterministic tests. */
  timestamp?: string
}

/**
 * Build the canonical DID-auth message. LF-joined, no trailing newline, UTF-8.
 * Byte-identical to `@attestto/id-wallet-adapter`'s `canonicalAuthMessage`:
 *
 *   attestto-did-auth-v1
 *   <did>
 *   <nonce>
 *   <audience>
 *   <origin>
 *   <timestamp>
 *
 * The DID is inside the signed payload so a signature captured for one DID
 * cannot be re-presented as another.
 */
export function canonicalAuthMessage(fields: {
  did: string
  nonce: string
  audience: string
  origin: string
  timestamp: string
}): string {
  return [
    DID_AUTH_CANONICAL_VERSION,
    fields.did,
    fields.nonce,
    fields.audience,
    fields.origin,
    fields.timestamp,
  ].join('\n')
}

/** base64url-encode raw bytes (no padding), matching the adapter's decoder. */
function bytesToBase64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Sign a DID-auth challenge with a pairwise P-256 key and assemble the
 * `AuthResponse` the verifier expects.
 *
 * The returned `signature` is base64url of the raw 64-byte r‖s value — never
 * DER — so the adapter's `verifyAuth` (which rejects non-64-byte signatures)
 * accepts it.
 */
export async function signDidAuth(params: SignDidAuthParams): Promise<WalletAuthResponse> {
  const timestamp = params.timestamp ?? new Date().toISOString()
  const message = canonicalAuthMessage({
    did: params.did,
    nonce: params.nonce,
    audience: params.audience,
    origin: params.origin,
    timestamp,
  })

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    params.privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message),
  )

  return {
    approved: true,
    did: params.did,
    nonce: params.nonce,
    audience: params.audience,
    origin: params.origin,
    signature: bytesToBase64url(new Uint8Array(sigBuffer)),
    publicKeyJwk: params.publicKeyJwk,
    timestamp,
  }
}
