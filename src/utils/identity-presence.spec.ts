import { describe, it, expect } from 'vitest'
import { hasIdentity } from './identity-presence'
import type { PublicVaultData } from './vault'

const base = (over: Partial<PublicVaultData>): PublicVaultData =>
  ({ did: null, ...over }) as PublicVaultData

describe('hasIdentity', () => {
  it('returns false when the public vault is missing', () => {
    expect(hasIdentity(null)).toBe(false)
    expect(hasIdentity(undefined)).toBe(false)
  })

  it('returns false for an empty / not-set-up vault', () => {
    expect(hasIdentity(base({ did: null }))).toBe(false)
    expect(hasIdentity(base({ did: null, holderDid: null, linkedIdentities: [] }))).toBe(false)
  })

  it('returns true when a root did is present', () => {
    expect(hasIdentity(base({ did: 'did:jwk:abc' }))).toBe(true)
  })

  it('returns true when a holderDid is present', () => {
    expect(hasIdentity(base({ did: null, holderDid: 'did:sns:alice.attestto.sol' }))).toBe(true)
  })

  it('returns true when at least one linked identity exists', () => {
    expect(
      hasIdentity(
        base({
          did: null,
          holderDid: null,
          linkedIdentities: [{ did: 'did:sns:bob.attestto.sol' } as NonNullable<PublicVaultData['linkedIdentities']>[number]],
        }),
      ),
    ).toBe(true)
  })
})
