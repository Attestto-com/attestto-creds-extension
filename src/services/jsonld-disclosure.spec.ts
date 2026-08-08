/**
 * Story 1.17 — JSON-LD selective disclosure.
 *
 * Every leak assertion is made against the SERIALIZED credential, not against
 * `Object.keys(credentialSubject)`. A key-list check passes for a value that
 * leaked by nesting — an unselected claim copied into a metadata blob, an
 * `evidence` array, a `credentialStatus` object — and those are exactly the
 * places a whole-VC over-share hides. Sentinel values make the check total.
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

const wire = (c: Record<string, unknown>): string => JSON.stringify(c)

describe('only the selected claims are emitted', () => {
  it('one selected claim: nothing else reaches the wire', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })

    expect(wire(credential)).not.toContain('LEAK-DOB')
    expect(wire(credential)).not.toContain('LEAK-CEDULA')
    expect(wire(credential)).not.toContain('LEAK-STREET')
    expect(wire(credential)).not.toContain('LEAK-CITY')
  })

  it('the selected claim IS emitted, with its value', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect((credential.credentialSubject as Record<string, unknown>).fullName).toBe('LEAK-NAME')
  })

  it('a nested object is withheld whole, not shallow-copied', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['nationalId'], { holderDid: HOLDER })
    expect(wire(credential)).not.toContain('LEAK-STREET')
    expect(wire(credential)).toContain('LEAK-CEDULA')
  })

  it('reports exactly what it withheld', () => {
    const { withheld } = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(withheld.sort()).toEqual(['address', 'dateOfBirth', 'nationalId'])
  })

  it('selecting nothing emits no subject claims at all', () => {
    const { credential } = deriveDisclosedCredential(vc(), [], { holderDid: HOLDER })
    expect(Object.keys(credential.credentialSubject as object)).toEqual(['id'])
    expect(wire(credential)).not.toContain('LEAK-')
  })

  it('a name that is not in the credential adds nothing', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName', 'salary'], { holderDid: HOLDER })
    expect(Object.keys(credential.credentialSubject as object).sort()).toEqual(['fullName', 'id'])
  })
})

describe('a partial disclosure is holder-attested, not issuer-attested', () => {
  it('drops the issuer proof — it no longer covers the document', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })

    expect(credential.proof).toBeUndefined()
    // The worst outcome would be keeping a signature that cannot verify: a lazy
    // verifier, or a human reading the JSON, would take it as issuer-attested.
    expect(wire(credential)).not.toContain('issuer-signature')
  })

  it('marks itself as derived so the downgrade is visible in the document', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(credential.type).toEqual(['VerifiableCredential', 'IdentityCredential', DERIVED_TYPE])
  })

  it('does not stack the derived marker if it is somehow already there', () => {
    const already = vc({ type: ['VerifiableCredential', DERIVED_TYPE] })
    const { credential } = deriveDisclosedCredential(already, ['fullName'], { holderDid: HOLDER })
    expect(credential.type).toEqual(['VerifiableCredential', DERIVED_TYPE])
  })

  it('keeps issuer, dates and context — a verifier still needs to know who said it', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName'], { holderDid: HOLDER })
    expect(credential).toMatchObject({
      issuer: 'did:web:gob.cr',
      issuanceDate: '2026-01-01T00:00:00Z',
      '@context': ['https://www.w3.org/2018/credentials/v1'],
    })
  })

  it('does not mutate the stored credential', () => {
    const source = vc()
    deriveDisclosedCredential(source, ['fullName'], { holderDid: HOLDER })
    expect(source.proof).toBeDefined()
    expect(Object.keys(source.credentialSubject as object)).toHaveLength(5)
  })
})

describe('full disclosure keeps the credential verifiable', () => {
  it('selecting every claim returns the document untouched, proof intact', () => {
    const source = vc()
    const result = deriveDisclosedCredential(
      source,
      ['fullName', 'dateOfBirth', 'nationalId', 'address'],
      { holderDid: HOLDER },
    )

    expect(result.complete).toBe(true)
    expect(result.credential).toBe(source)
    expect((result.credential as Record<string, unknown>).proof).toBeDefined()
    expect(result.credential.type).not.toContain(DERIVED_TYPE)
  })

  it('withholding even one claim is not complete', () => {
    const result = deriveDisclosedCredential(vc(), ['fullName', 'dateOfBirth', 'nationalId'], {
      holderDid: HOLDER,
    })
    expect(result.complete).toBe(false)
  })
})

describe('the subject identifier', () => {
  it('is kept when it names the holder — the VP already reveals that DID', () => {
    const { credential, withheld } = deriveDisclosedCredential(vc(), ['fullName'], {
      holderDid: HOLDER,
    })
    expect((credential.credentialSubject as Record<string, unknown>).id).toBe(HOLDER)
    expect(withheld).not.toContain('id')
  })

  it('is withheld when the subject is somebody else', () => {
    // A third-party credential: the subject id identifies a person other than
    // the presenter, so it is a claim the user did not choose to share.
    const thirdParty = vc({
      credentialSubject: { id: 'did:jwk:someone-else', fullName: 'LEAK-NAME' },
    })
    const { credential } = deriveDisclosedCredential(thirdParty, ['fullName'], { holderDid: HOLDER })

    expect(wire(credential)).not.toContain('someone-else')
  })

  it('is withheld when no holder DID was supplied', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName'])
    expect((credential.credentialSubject as Record<string, unknown>).id).toBeUndefined()
  })

  it('can still be selected explicitly', () => {
    const thirdParty = vc({ credentialSubject: { id: 'did:jwk:someone-else', fullName: 'n' } })
    const { credential } = deriveDisclosedCredential(thirdParty, ['id'], { holderDid: HOLDER })
    expect((credential.credentialSubject as Record<string, unknown>).id).toBe('did:jwk:someone-else')
  })
})

describe('the selection list is untrusted input', () => {
  it('a prototype-chain name copies nothing out', () => {
    // Story 1.13 Phase 8 found this live on the SD-JWT reshare path: `field in
    // subject` walks the prototype, so `constructor` copies an Object.prototype
    // member into the output.
    const { credential } = deriveDisclosedCredential(
      vc(),
      ['constructor', 'toString', 'hasOwnProperty', '__proto__'],
      { holderDid: HOLDER },
    )
    const subject = credential.credentialSubject as Record<string, unknown>

    expect(Object.keys(subject)).toEqual(['id'])
    expect(subject.constructor).toBeUndefined()
  })

  it('`__proto__` in the selection does not reassign the output prototype', () => {
    const poisoned = vc({ credentialSubject: { fullName: 'n', __proto__: { polluted: true } } })
    const { credential } = deriveDisclosedCredential(poisoned, ['__proto__'], {})
    expect((credential.credentialSubject as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('a duplicated name emits the claim once', () => {
    const { credential } = deriveDisclosedCredential(vc(), ['fullName', 'fullName'], {})
    expect(Object.keys(credential.credentialSubject as object)).toEqual(['fullName'])
  })
})

describe('shapes we do not model', () => {
  it('a VC with no credentialSubject passes through rather than throwing', () => {
    const odd = { '@context': [], type: ['VerifiableCredential'], proof: { jws: 'x' } }
    const result = deriveDisclosedCredential(odd, ['anything'])
    expect(result).toEqual({ credential: odd, withheld: [], complete: true })
  })

  it('an array credentialSubject passes through — filtering it would guess', () => {
    // Multi-subject VCs are legal. Silently picking one is worse than declining
    // to filter, and `complete: true` tells the caller the proof is intact.
    const multi = vc({ credentialSubject: [{ id: 'a' }, { id: 'b' }] })
    expect(deriveDisclosedCredential(multi, ['id']).complete).toBe(true)
  })
})
