/**
 * JSON-LD disclosure — REWRITTEN 2026-08-09 when partial disclosure became a
 * refusal rather than a proof-stripped derivation.
 *
 * The old suite asserted that a partial disclosure emitted a `DerivedCredential`
 * with the issuer proof removed. Those tests were correct for the code as it
 * stood; they are deleted rather than adapted, because the behaviour they pinned
 * is the behaviour that was decided against. Keeping them "passing" by loosening
 * assertions would leave a suite that no longer describes the product.
 *
 * What survives unchanged is the discipline: every leak assertion runs against
 * the SERIALIZED credential, not `Object.keys(credentialSubject)`. A key-list
 * check passes for a value that leaked by nesting — into a metadata blob, an
 * `evidence` array, a `credentialStatus` object — and those are exactly where a
 * whole-VC over-share hides. Sentinel values make the check total.
 */
import { describe, it, expect } from 'vitest'
import { deriveDisclosedCredential, DERIVED_TYPE } from './jsonld-disclosure'

const HOLDER = 'did:jwk:holder-abc'

/** Every withheld value is a sentinel, so any leak anywhere is findable. */
function vc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:cred-1',
    type: ['VerifiableCredential', 'IdentityCredential'],
    issuer: 'did:web:gob.cr',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: {
      id: HOLDER,
      fullName: 'LEAK-NAME',
      dateOfBirth: 'LEAK-DOB',
      nationalId: 'LEAK-CEDULA',
      address: { street: 'LEAK-STREET', city: 'LEAK-CITY' },
    },
    proof: { type: 'Ed25519Signature2020', jws: 'issuer-signature' },
    ...overrides,
  }
}

const ALL_CLAIMS = ['fullName', 'dateOfBirth', 'nationalId', 'address']

/**
 * 🛑 The decision. JSON-LD cannot disclose a subset and stay issuer-verifiable,
 * so a subset request is refused instead of downgraded.
 */
describe('partial disclosure is refused, not downgraded', () => {
  it('refuses when any claim would be withheld', () => {
    const result = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('partial-disclosure-unsupported')
  })

  it('🔒 the refusal carries NO credential to reach for', () => {
    // The shape is the control. The old return gave callers a usable
    // `credential` alongside `complete: false`, and a caller could — and did —
    // ignore the flag. There is no such field on this branch now.
    const result = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(result).not.toHaveProperty('credential')
    expect(JSON.stringify(result)).not.toContain('LEAK-NAME')
    expect(JSON.stringify(result)).not.toContain('issuer-signature')
  })

  it('names what would have been withheld, for an explanatory message', () => {
    const result = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(result.ok === false && [...result.withheld].sort()).toEqual([
      'address',
      'dateOfBirth',
      'nationalId',
    ])
  })

  it('refuses even when only ONE claim is withheld', () => {
    const result = deriveDisclosedCredential(
      vc(),
      ['fullName', 'dateOfBirth', 'nationalId'],
      { holderDid: HOLDER },
    )
    expect(result.ok).toBe(false)
  })

  it('refuses when nothing is selected', () => {
    expect(deriveDisclosedCredential(vc(), [], { holderDid: HOLDER }).ok).toBe(false)
  })

  it('🩸 never emits a proof-stripped derivation', () => {
    // The behaviour removed on 2026-08-09: privacy-correct but unverifiable, so
    // the user consented and the verifier rejected after the fact.
    const result = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(JSON.stringify(result)).not.toContain(DERIVED_TYPE)
  })
})

/**
 * The common case is untouched: selecting everything keeps the document and its
 * issuer proof exactly as issued.
 */
describe('full disclosure is unaffected', () => {
  it('returns the document byte-identical, proof intact', () => {
    const source = vc()
    const result = deriveDisclosedCredential(source, ALL_CLAIMS, { holderDid: HOLDER })
    expect(result.ok).toBe(true)
    expect(result.ok && result.credential).toEqual(source)
    expect(result.ok && (result.credential.proof as object)).toEqual({
      type: 'Ed25519Signature2020',
      jws: 'issuer-signature',
    })
  })

  it('does not mutate the stored credential', () => {
    const source = vc()
    const before = JSON.stringify(source)
    deriveDisclosedCredential(source, ALL_CLAIMS, { holderDid: HOLDER })
    deriveDisclosedCredential(source, ['fullName'], { holderDid: HOLDER })
    expect(JSON.stringify(source)).toBe(before)
  })

  it('the subject id does not need selecting when it names the holder', () => {
    // `id` is the holder's own DID, already revealed by the VP envelope, so it
    // is not treated as a withheld claim.
    const result = deriveDisclosedCredential(vc(), ALL_CLAIMS, { holderDid: HOLDER })
    expect(result.ok).toBe(true)
  })

  it('🔒 a THIRD-PARTY subject id counts as a claim and forces a refusal', () => {
    // Someone else's identifier is not ours to disclose implicitly. Selecting
    // every named claim still leaves `id` withheld, so this must refuse.
    const thirdParty = vc({
      credentialSubject: { ...(vc().credentialSubject as object), id: 'did:web:someone-else' },
    })
    const result = deriveDisclosedCredential(thirdParty, ALL_CLAIMS, { holderDid: HOLDER })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.withheld).toContain('id')
  })

  it('a third-party subject id CAN be selected explicitly', () => {
    const thirdParty = vc({
      credentialSubject: { ...(vc().credentialSubject as object), id: 'did:web:someone-else' },
    })
    const result = deriveDisclosedCredential(thirdParty, [...ALL_CLAIMS, 'id'], {
      holderDid: HOLDER,
    })
    expect(result.ok).toBe(true)
  })

  it('with no holder DID supplied, the subject id is a withheld claim', () => {
    expect(deriveDisclosedCredential(vc(), ALL_CLAIMS).ok).toBe(false)
  })
})

describe('shapes we do not model', () => {
  it('a VC with no credentialSubject passes through rather than throwing', () => {
    const noSubject = { id: 'urn:uuid:x', type: ['VerifiableCredential'] }
    const result = deriveDisclosedCredential(noSubject, ['anything'])
    expect(result.ok).toBe(true)
    expect(result.ok && result.credential).toEqual(noSubject)
  })

  it('an array credentialSubject passes through — filtering it would guess', () => {
    const arraySubject = vc({ credentialSubject: [{ id: HOLDER, a: 1 }] })
    const result = deriveDisclosedCredential(arraySubject, ['a'])
    expect(result.ok).toBe(true)
  })
})

/**
 * The selection list comes from a UI and is untrusted. These pinned real
 * defects in Story 1.13 Phase 8 and stay relevant: they decide whether a
 * request counts as full or partial disclosure, which now decides refusal.
 */
describe('the selection list is untrusted input', () => {
  it('a prototype-chain name does not count as selecting a claim', () => {
    // `constructor` is not an own property of the subject, so selecting it
    // discloses nothing and leaves the real claims withheld → refusal.
    const result = deriveDisclosedCredential(vc(), ['constructor', 'toString'], {
      holderDid: HOLDER,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.withheld).toEqual(
      expect.arrayContaining(['fullName', 'nationalId']),
    )
  })

  it('`__proto__` in the selection does not satisfy the full-disclosure check', () => {
    const result = deriveDisclosedCredential(vc(), ['__proto__', ...ALL_CLAIMS], {
      holderDid: HOLDER,
    })
    // Every real claim was named, so this is full disclosure; `__proto__` must
    // neither break it nor smuggle anything in.
    expect(result.ok).toBe(true)
    expect(result.ok && Object.getPrototypeOf(result.credential)).toBe(Object.prototype)
  })

  it('a duplicated name is harmless', () => {
    const result = deriveDisclosedCredential(vc(), [...ALL_CLAIMS, 'fullName'], {
      holderDid: HOLDER,
    })
    expect(result.ok).toBe(true)
  })

  it('a name that is not in the credential does not count toward disclosure', () => {
    const result = deriveDisclosedCredential(vc(), ['notAClaim'], { holderDid: HOLDER })
    expect(result.ok).toBe(false)
  })
})
