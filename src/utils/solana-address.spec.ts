import { describe, it, expect } from 'vitest'
import { isValidSolanaAddress, base58Decode } from './solana-address'

describe('isValidSolanaAddress', () => {
  it('accepts real 32-byte base58 Solana addresses', () => {
    // System program, a wrapped-SOL mint, and the Token program id.
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true)
    expect(isValidSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true)
    expect(isValidSolanaAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true)
  })

  it('rejects non-base58 characters', () => {
    expect(isValidSolanaAddress('0OIl_not_base58')).toBe(false)
    expect(isValidSolanaAddress('abc def')).toBe(false)
  })

  it('rejects strings that do not decode to 32 bytes', () => {
    expect(isValidSolanaAddress('abc')).toBe(false) // too short
    expect(isValidSolanaAddress('')).toBe(false)
    // Valid base58 but far too long (>32 bytes)
    expect(isValidSolanaAddress('1'.repeat(64))).toBe(false)
  })

  it('base58Decode returns null on invalid input, bytes otherwise', () => {
    expect(base58Decode('0')).toBeNull() // '0' is not in the alphabet
    expect(base58Decode('11111111111111111111111111111111')?.length).toBe(32)
  })
})
