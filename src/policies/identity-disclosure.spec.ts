/**
 * Story 1.8 — the sensitive-field disclosure policy, ENFORCED (FR9).
 *
 * The policy was zero-callsite (advertised-but-dead — its own doc claimed a
 * consumer that didn't exist). This story wires `disclosureTierFor` into
 * `PresentCredentialView` (the rendered-badge test lives in that component spec).
 * Here we pin the policy primitive the call site depends on, so flipping a tier
 * reddens (AD-13). Independent referent = the tier the policy assigns a path.
 */
import { describe, it, expect } from 'vitest'
import { disclosureTierFor, isSensitiveField, IDENTITY_DISCLOSURE_POLICY } from './identity-disclosure'

describe('disclosureTierFor — the enforcement primitive', () => {
  it('marks the PII fields sensitive (cédula, DOB, org roles)', () => {
    expect(disclosureTierFor('nationalId.number')).toBe('sensitive')
    expect(disclosureTierFor('dateOfBirth')).toBe('sensitive')
    expect(disclosureTierFor('organizationRoles')).toBe('sensitive')
  })

  it('marks low-risk fields standard (positive control — not everything is sensitive)', () => {
    expect(disclosureTierFor('fullName')).toBe('standard')
    expect(disclosureTierFor('nationality')).toBe('standard')
    expect(disclosureTierFor('nationalId.type')).toBe('standard')
  })

  it('defaults an UNKNOWN claim to standard, never crashes (fail-safe UI)', () => {
    expect(disclosureTierFor('some.unlisted.claim')).toBe('standard')
    expect(disclosureTierFor('')).toBe('standard')
  })

  it('agrees with isSensitiveField (one source of truth)', () => {
    for (const f of IDENTITY_DISCLOSURE_POLICY.fields) {
      expect(disclosureTierFor(f.path) === 'sensitive').toBe(isSensitiveField(f.path))
    }
  })
})
