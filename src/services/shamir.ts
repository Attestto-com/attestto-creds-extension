/**
 * Shamir Secret Sharing — 2-of-2 threshold for dual-key encryption.
 *
 * Splits an AES-256-GCM CEK into two XOR shares:
 *   Share A → stored in Vault Extension (user's device)
 *   Share B → stored on Attestto platform (PII Vault)
 *
 * For 2-of-2, XOR is sufficient and avoids polynomial overhead.
 * Both shares are required to reconstruct the CEK.
 */

/**
 * Split a key into two XOR shares (2-of-2 threshold).
 *
 * @param key - The content encryption key (CEK) as Uint8Array
 * @returns [shareA, shareB] — XOR complements
 */
export function splitKey(key: Uint8Array): [Uint8Array, Uint8Array] {
  const shareA = crypto.getRandomValues(new Uint8Array(key.length))
  const shareB = new Uint8Array(key.length)

  for (let i = 0; i < key.length; i++) {
    shareB[i] = key[i] ^ shareA[i]
  }

  return [shareA, shareB]
}

/**
 * Reconstruct the original key from two XOR shares.
 *
 * @param shareA - User's share (from Vault Extension)
 * @param shareB - Platform's share (from Attestto API)
 * @returns The reconstructed CEK
 */
export function combineShares(shareA: Uint8Array, shareB: Uint8Array): Uint8Array {
  if (shareA.length !== shareB.length) {
    throw new Error('Share length mismatch')
  }

  const key = new Uint8Array(shareA.length)
  for (let i = 0; i < key.length; i++) {
    key[i] = shareA[i] ^ shareB[i]
  }

  return key
}

// ── 2-of-3 Shamir (Key Recovery — Phase E) ──────────────────────────────────

/**
 * Split a secret into 3 shares where any 2 can reconstruct it (2-of-3).
 *
 * Uses GF(256) arithmetic over a degree-1 polynomial:
 *   f(x) = secret + a1*x  (mod GF(256))
 *
 * Shares are f(1), f(2), f(3). Any 2 shares reconstruct via Lagrange interpolation.
 *
 * Used for extension private key backup (device + cloud + guardian).
 */
export function split2of3(secret: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const len = secret.length
  const share1 = new Uint8Array(len)
  const share2 = new Uint8Array(len)
  const share3 = new Uint8Array(len)

  // Random coefficient a1 for each byte
  const a1 = crypto.getRandomValues(new Uint8Array(len))

  for (let i = 0; i < len; i++) {
    // f(x) = secret[i] + a1[i]*x in GF(256)
    share1[i] = gf256Add(secret[i], gf256Mul(a1[i], 1)) // f(1)
    share2[i] = gf256Add(secret[i], gf256Mul(a1[i], 2)) // f(2)
    share3[i] = gf256Add(secret[i], gf256Mul(a1[i], 3)) // f(3)
  }

  return [share1, share2, share3]
}

/**
 * Reconstruct a secret from any 2 of 3 shares (2-of-3 threshold).
 *
 * @param shareA - First share with its index (1, 2, or 3)
 * @param shareB - Second share with its index (1, 2, or 3)
 * @returns The reconstructed secret
 */
export function combine2of3(
  shareA: { data: Uint8Array; index: number },
  shareB: { data: Uint8Array; index: number },
): Uint8Array {
  if (shareA.data.length !== shareB.data.length) {
    throw new Error('Share length mismatch')
  }
  if (shareA.index === shareB.index) {
    throw new Error('Cannot reconstruct from two identical share indices')
  }
  if (shareA.index < 1 || shareA.index > 3 || shareB.index < 1 || shareB.index > 3) {
    throw new Error('Share index must be 1, 2, or 3')
  }

  const len = shareA.data.length
  const result = new Uint8Array(len)

  const xA = shareA.index
  const xB = shareB.index

  // Lagrange interpolation at x=0 in GF(256):
  // f(0) = yA * (0 - xB) / (xA - xB) + yB * (0 - xA) / (xB - xA)
  // In GF(256): subtraction = XOR, division = mul by inverse
  const denomA = gf256Add(xA, xB)   // xA - xB = xA ^ xB in GF(256)
  const denomB = gf256Add(xB, xA)   // xB - xA = xB ^ xA in GF(256) (same value)
  const lagA = gf256Mul(xB, gf256Inv(denomA)) // (0 - xB) / (xA - xB) = xB / (xA ^ xB)
  const lagB = gf256Mul(xA, gf256Inv(denomB)) // (0 - xA) / (xB - xA) = xA / (xB ^ xA)

  for (let i = 0; i < len; i++) {
    result[i] = gf256Add(
      gf256Mul(shareA.data[i], lagA),
      gf256Mul(shareB.data[i], lagB),
    )
  }

  return result
}

// ── GF(256) Arithmetic ──────────────────────────────────────────────────────

/** GF(256) addition (XOR) */
function gf256Add(a: number, b: number): number {
  return a ^ b
}

/** GF(256) multiplication using Russian Peasant algorithm */
function gf256Mul(a: number, b: number): number {
  let result = 0
  let _a = a
  let _b = b
  for (let i = 0; i < 8; i++) {
    if (_b & 1) result ^= _a
    const carry = _a & 0x80
    _a = (_a << 1) & 0xff
    if (carry) _a ^= 0x1b // AES irreducible polynomial x^8 + x^4 + x^3 + x + 1
    _b >>= 1
  }
  return result
}

/** GF(256) multiplicative inverse via extended Euclidean / exponentiation */
function gf256Inv(a: number): number {
  if (a === 0) throw new Error('Cannot invert zero in GF(256)')
  // a^254 = a^(-1) in GF(256) since a^255 = 1 (Fermat's little theorem)
  let result = a
  for (let i = 0; i < 6; i++) {
    result = gf256Mul(result, result) // square
    result = gf256Mul(result, a)      // multiply by a
  }
  result = gf256Mul(result, result) // final square → a^254
  return result
}

/**
 * Encode a Uint8Array to base64url (no padding).
 */
export function toBase64Url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Decode a base64url string to Uint8Array.
 */
export function fromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}
