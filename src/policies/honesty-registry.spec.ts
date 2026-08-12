/**
 * Story 1.8 — the honesty counter-metric (FR10 + the guard).
 *
 * The initiative exists because the wallet advertised capabilities that didn't
 * run. This guard is a CURATED registry binding each advertised capability to a
 * BEHAVIORAL smoke that exercises it. It is NOT a source-text grep (the govscan
 * source-mirror sin — a string in source proves nothing about behavior); each
 * smoke calls the real implementation and asserts a real result.
 *
 * The guard reddens when an advertisement outlives its implementation:
 *   - a capability's impl is deleted/renamed → its smoke throws → red.
 *   - a retired placeholder is re-added / re-advertised → the retired check reds.
 *
 * Scope is deliberately this story's surface (Vex: a curated counter-metric beats
 * a magic scanner that pretends to cover everything and quietly doesn't). New
 * advertised capabilities add an entry here with their own behavioral smoke.
 */
import { describe, it, expect } from 'vitest'
import * as didcomm from '@/services/didcomm'
import { disclosureTierFor } from './identity-disclosure'

interface AdvertisedCapability {
  capability: string
  /** A behavioral smoke: calls the real impl, asserts a real result. Throws if dead. */
  smoke: () => void
}

const ADVERTISED_CAPABILITIES: AdvertisedCapability[] = [
  {
    capability: 'didcomm-inbound: parse an inbound proof request',
    smoke: () => {
      const parsed = didcomm.parseProofRequest({
        id: 'req-smoke',
        type: 'https://didcomm.org/present-proof/3.0/request-presentation',
        from: 'did:example:verifier',
        body: {
          request_presentations_attach: [
            { id: 'a0', data: { nonce: 'n', requestedFields: ['fullName'] } },
          ],
        },
      })
      // A live parser returns a structured result for a well-formed message.
      expect(parsed).not.toBeNull()
      expect(parsed?.from).toBe('did:example:verifier')
    },
  },
  {
    capability: 'sensitive-field disclosure: PII fields are tiered sensitive',
    smoke: () => {
      // Exercises the policy the PresentCredentialView badge is wired to.
      expect(disclosureTierFor('nationalId.number')).toBe('sensitive')
    },
  },
]

describe('honesty counter-metric — every advertised capability is behaviorally live', () => {
  it.each(ADVERTISED_CAPABILITIES)('$capability', ({ smoke }) => {
    // Reddens if the advertised capability has no live implementation.
    expect(() => smoke()).not.toThrow()
  })

  it('retired DIDComm placeholders are NOT re-advertised (dead code stays dead)', () => {
    // These were tested placeholders with zero production callsites (Story 1.8).
    // If they resurface as exports, the advertisement/implementation drift returns.
    expect((didcomm as Record<string, unknown>).buildPresentationResponse).toBeUndefined()
    expect((didcomm as Record<string, unknown>).buildProblemReport).toBeUndefined()
  })
})
