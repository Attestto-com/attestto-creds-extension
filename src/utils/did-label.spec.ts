/**
 * Story 1.10 — characterization of the single-sourced `extractDidLabel` (AD-4).
 *
 * The three legacy copies were byte-identical; this pins the three branches so the
 * dedup (repointing background's two call sites + wallet.ts's private copy) is
 * guarded against a transcription slip.
 */
import { describe, it, expect } from 'vitest'
import { extractDidLabel } from './did-label'

describe('extractDidLabel', () => {
  it('did:sns → the suffix after did:sns:', () => {
    expect(extractDidLabel('did:sns:chongkan.attestto.sol')).toBe('chongkan.attestto.sol')
  })

  it('did:web → colons in the method-specific id become slashes', () => {
    expect(extractDidLabel('did:web:example.com:users:alice')).toBe('example.com/users/alice')
  })

  it('unknown method → the DID verbatim', () => {
    expect(extractDidLabel('did:jwk:eyJrdHkiOiJFQyJ9')).toBe('did:jwk:eyJrdHkiOiJFQyJ9')
    expect(extractDidLabel('did:pkh:eip155:1:0xabc')).toBe('did:pkh:eip155:1:0xabc')
  })
})
