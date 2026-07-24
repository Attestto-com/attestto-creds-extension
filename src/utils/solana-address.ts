/**
 * Lightweight Solana address validation — dependency-free.
 *
 * Replaces the sole reason `wallet.ts` constructed a `@solana/web3.js`
 * `PublicKey` (base58 validity). Dropping that heavy dependency also removes its
 * vulnerable `jayson → uuid` subtree from the shipped bundle (SOC-13).
 */

// Bitcoin/Solana base58 alphabet (no 0, O, I, l).
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Decode a base58 string to bytes, or null if it contains an invalid character. */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null
  const bytes: number[] = []
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch)
    if (carry < 0) return null
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  // Each leading '1' encodes a leading zero byte.
  for (let k = 0; k < input.length && input[k] === '1'; k++) bytes.push(0)
  return Uint8Array.from(bytes.reverse())
}

/** True when `address` is a valid base58-encoded 32-byte Solana public key. */
export function isValidSolanaAddress(address: string): boolean {
  const decoded = base58Decode(address)
  return decoded !== null && decoded.length === 32
}
