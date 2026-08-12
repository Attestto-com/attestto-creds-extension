/**
 * Story 1.11 — compact JWS assembly with an INJECTED signer (AD-11c).
 *
 * `jose`'s `SignJWT(...).sign(key)` welds three steps: import the private key,
 * base64url-encode `header.payload`, and sign those bytes. That makes it impossible
 * to route the signature through the one gated primitive — the key is imported and
 * signed with inside jose. This module splits the seam: it builds the exact
 * ES256 signing input (`base64url(header) . base64url(payload)`) and hands THOSE
 * bytes to an injected `JwsSigner`, then appends the returned signature. The signer
 * is the only thing that touches key material — so a caller in the background can
 * pass the gated primitive, while a caller in the popup passes a local key signer.
 *
 * Crypto note (why raw, not DER): a JWS ES256 signature is the raw 64-byte R‖S
 * concatenation (RFC 7515 / RFC 7518 §3.4), which is EXACTLY what WebCrypto
 * `crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, …)` returns — no DER
 * re-encoding. `es256KeySigner` relies on that; the gated background signer does too.
 */

/** Signs the JWS signing input, returning the raw ES256 signature (64-byte R‖S). */
export type JwsSigner = (signingInput: Uint8Array) => Promise<Uint8Array>

/** base64url (no padding) of raw bytes — RFC 7515 §2. */
export function base64urlBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url of a JSON object (its UTF-8 serialization). */
export function base64urlJson(obj: unknown): string {
  return base64urlBytes(new TextEncoder().encode(JSON.stringify(obj)))
}

/**
 * Assemble a compact JWS: `base64url(header).base64url(payload).base64url(sig)`.
 * The signer receives the exact `header.payload` bytes it must sign — so what is
 * signed is provably what is emitted (no re-encode between sign and assemble).
 */
export async function signCompactJws(
  protectedHeader: Record<string, unknown>,
  payload: Record<string, unknown>,
  sign: JwsSigner,
): Promise<string> {
  const signingInput = `${base64urlJson(protectedHeader)}.${base64urlJson(payload)}`
  const signature = await sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64urlBytes(signature)}`
}

/**
 * A `JwsSigner` bound to a raw P-256 private JWK, signing with WebCrypto ECDSA
 * (raw R‖S output — JWS-ready). For UNGATED contexts only (the popup, post-unlock):
 * the background must instead wrap key signing in the gated primitive, never import
 * a key and sign here (AD-11c / the key-based invariant is background-scoped).
 */
export function es256KeySigner(privateJwk: JsonWebKey): JwsSigner {
  return async (signingInput: Uint8Array): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    const buf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput as BufferSource)
    return new Uint8Array(buf)
  }
}
