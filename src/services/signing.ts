/**
 * Generic payload signing service.
 *
 * Reads the private key from the vault and signs arbitrary payloads
 * with ECDSA P-256 SHA-256 using the Web Crypto API.
 */

import { readVault } from '@/utils/vault'

export interface SignResult {
  ok: boolean
  signature?: string
  error?: string
}

/**
 * Sign a base64-encoded payload using the holder's ECDSA P-256 private key.
 *
 * @param payloadBase64 - The data to sign, base64-encoded
 * @returns Base64 signature or error
 */
export async function signPayload(payloadBase64: string): Promise<SignResult> {
  try {
    const vault = await readVault()
    if (!vault?.privateKeyJwk) {
      return { ok: false, error: 'Wallet is locked or has no key pair' }
    }

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      vault.privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )

    const data = Uint8Array.from(atob(payloadBase64), (c) => c.charCodeAt(0))

    const signatureBuffer = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      data,
    )

    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    return { ok: true, signature }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Signing failed' }
  }
}
