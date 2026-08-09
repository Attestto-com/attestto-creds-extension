import { describe, it, expect } from 'vitest'
import { parseDidDocument, MAX_VERIFICATION_METHODS } from './did-document'

const DID = 'did:web:id.example.org'
const VM_ID = `${DID}#key-1`

const P256_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
}

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: DID,
    verificationMethod: [
      { id: VM_ID, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: P256_JWK },
    ],
    authentication: [VM_ID],
    assertionMethod: [VM_ID],
    ...overrides,
  }
}

describe('parseDidDocument — the happy path', () => {
  it('returns the validated document', () => {
    const result = parseDidDocument(doc(), DID)
    expect(result).toEqual({
      ok: true,
      value: {
        id: DID,
        verificationMethod: [
          { id: VM_ID, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: P256_JWK },
        ],
        authentication: [VM_ID],
        assertionMethod: [VM_ID],
      },
    })
  })

  it('accepts an Ed25519 OKP key', () => {
    const okp = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }
    const result = parseDidDocument(
      doc({
        verificationMethod: [
          { id: VM_ID, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: okp },
        ],
      }),
      DID,
    )
    expect(result.ok && result.value.verificationMethod[0].publicKeyJwk).toEqual(okp)
  })
})

/**
 * 🔒 THE control. Without it, `resolve()` means "fetch JSON from a host this DID
 * names and believe whatever it says" — any endpoint returning a JSON body can
 * hand back keys it does not control.
 */
describe('parseDidDocument — the id must match the DID that was requested', () => {
  it('rejects a document claiming a different DID', () => {
    expect(parseDidDocument(doc({ id: 'did:web:evil.example' }), DID)).toEqual({
      ok: false,
      reason: 'id-mismatch',
    })
  })

  it('rejects a document with no id at all', () => {
    const { id: _omitted, ...withoutId } = doc()
    expect(parseDidDocument(withoutId, DID)).toEqual({ ok: false, reason: 'id-mismatch' })
  })

  it('rejects a non-string id', () => {
    expect(parseDidDocument(doc({ id: 42 }), DID)).toEqual({ ok: false, reason: 'id-mismatch' })
  })

  it('is exact, not a prefix match', () => {
    // `did:web:id.example.org.evil.example` starts with the expected DID.
    expect(parseDidDocument(doc({ id: `${DID}.evil.example` }), DID)).toEqual({
      ok: false,
      reason: 'id-mismatch',
    })
  })

  it('never returns a value whose id differs from the requested DID', () => {
    // The structural version of the above: whatever comes out is keyed to what
    // was asked for, so a caller cannot be handed someone else's document.
    for (const candidate of ['did:web:evil.example', '', null, undefined, DID]) {
      const result = parseDidDocument(doc({ id: candidate }), DID)
      if (result.ok) expect(result.value.id).toBe(DID)
    }
  })
})

describe('parseDidDocument — verification methods are scoped to the subject', () => {
  it('rejects a method whose id belongs to another DID', () => {
    expect(
      parseDidDocument(
        doc({
          verificationMethod: [
            {
              id: 'did:web:evil.example#k',
              type: 'JsonWebKey2020',
              controller: DID,
              publicKeyJwk: P256_JWK,
            },
          ],
        }),
        DID,
      ),
    ).toEqual({ ok: false, reason: 'invalid-verification-method' })
  })

  it('rejects a method controlled by another DID', () => {
    expect(
      parseDidDocument(
        doc({
          verificationMethod: [
            {
              id: VM_ID,
              type: 'JsonWebKey2020',
              controller: 'did:web:evil.example',
              publicKeyJwk: P256_JWK,
            },
          ],
        }),
        DID,
      ),
    ).toEqual({ ok: false, reason: 'invalid-verification-method' })
  })

  it('fails the WHOLE document when one method is unparseable', () => {
    // Skipping the bad entry would mean a later "that key is not in the
    // document" verdict might be our parser's doing, not the issuer's.
    const result = parseDidDocument(
      doc({
        verificationMethod: [
          { id: VM_ID, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: P256_JWK },
          { id: `${DID}#key-2`, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: { kty: 'RSA' } },
        ],
      }),
      DID,
    )
    expect(result).toEqual({ ok: false, reason: 'invalid-verification-method' })
  })

  it('rejects a document with no verification methods', () => {
    expect(parseDidDocument(doc({ verificationMethod: [] }), DID)).toEqual({
      ok: false,
      reason: 'no-verification-methods',
    })
    expect(parseDidDocument(doc({ verificationMethod: undefined }), DID)).toEqual({
      ok: false,
      reason: 'no-verification-methods',
    })
  })

  it('caps the number of methods', () => {
    const many = Array.from({ length: MAX_VERIFICATION_METHODS + 1 }, (_, i) => ({
      id: `${DID}#k${i}`,
      type: 'JsonWebKey2020',
      controller: DID,
      publicKeyJwk: P256_JWK,
    }))
    expect(parseDidDocument(doc({ verificationMethod: many }), DID)).toEqual({
      ok: false,
      reason: 'too-many-verification-methods',
    })
  })
})

/**
 * A private key in a public document is never legitimate. Storing one would put
 * someone else's secret into our vault.
 */
describe('parseDidDocument — JWK validation', () => {
  it('rejects a JWK carrying a private component', () => {
    expect(
      parseDidDocument(
        doc({
          verificationMethod: [
            {
              id: VM_ID,
              type: 'JsonWebKey2020',
              controller: DID,
              publicKeyJwk: { ...P256_JWK, d: 'SECRET-PRIVATE-SCALAR' },
            },
          ],
        }),
        DID,
      ),
    ).toEqual({ ok: false, reason: 'invalid-verification-method' })
  })

  it('never lets a private scalar reach the output', () => {
    // Independent referent: scan the SERIALIZED result, not the shape we expect.
    // A future parser that copied the JWK wholesale would pass the test above
    // (it would still reject) but fail this one if it ever started accepting.
    const result = parseDidDocument(
      doc({
        verificationMethod: [
          {
            id: VM_ID,
            type: 'JsonWebKey2020',
            controller: DID,
            publicKeyJwk: { ...P256_JWK, d: 'SECRET-PRIVATE-SCALAR' },
          },
        ],
      }),
      DID,
    )
    expect(JSON.stringify(result)).not.toContain('SECRET-PRIVATE-SCALAR')
  })

  it.each([
    ['an unsupported curve', { kty: 'EC', crv: 'P-521', x: 'aa', y: 'bb' }],
    ['an unsupported key type', { kty: 'RSA', n: 'aa', e: 'AQAB' }],
    ['a missing x', { kty: 'EC', crv: 'P-256', y: 'bb' }],
    ['a missing y on EC', { kty: 'EC', crv: 'P-256', x: 'aa' }],
    ['a y present on OKP', { kty: 'OKP', crv: 'Ed25519', x: 'aa', y: 'bb' }],
    ['non-base64url coordinates', { kty: 'EC', crv: 'P-256', x: 'a+/b', y: 'bb' }],
    ['a null jwk', null],
    ['a string jwk', 'not-a-jwk'],
  ])('rejects %s', (_label, publicKeyJwk) => {
    expect(
      parseDidDocument(
        doc({
          verificationMethod: [
            { id: VM_ID, type: 'JsonWebKey2020', controller: DID, publicKeyJwk },
          ],
        }),
        DID,
      ),
    ).toEqual({ ok: false, reason: 'invalid-verification-method' })
  })
})

describe('parseDidDocument — relationships', () => {
  it('drops references to methods the document does not define', () => {
    const result = parseDidDocument(
      doc({ authentication: [VM_ID, 'did:web:evil.example#k', `${DID}#nope`] }),
      DID,
    )
    expect(result.ok && result.value.authentication).toEqual([VM_ID])
  })

  it('drops embedded method objects rather than treating them as keys', () => {
    const result = parseDidDocument(
      doc({
        authentication: [
          { id: `${DID}#embedded`, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: P256_JWK },
        ],
      }),
      DID,
    )
    expect(result.ok && result.value.authentication).toEqual([])
  })

  it('defaults a missing relationship to empty rather than to every key', () => {
    const result = parseDidDocument(doc({ authentication: undefined }), DID)
    expect(result.ok && result.value.authentication).toEqual([])
  })
})

describe('parseDidDocument — unknown properties are dropped', () => {
  it('does not carry attacker-authored top-level fields through', () => {
    const result = parseDidDocument(
      doc({ proof: { jws: 'FORGED' }, alsoKnownAs: ['did:web:evil.example'], service: [{ x: 1 }] }),
      DID,
    )
    expect(result.ok).toBe(true)
    // Serialized scan: the output must not contain the dropped fields at all.
    expect(JSON.stringify(result)).not.toContain('FORGED')
    expect(JSON.stringify(result)).not.toContain('evil.example')
    expect(result.ok && Object.keys(result.value).sort()).toEqual([
      'assertionMethod',
      'authentication',
      'id',
      'verificationMethod',
    ])
  })
})

describe('parseDidDocument — non-objects', () => {
  it.each([null, undefined, 'str', 42, [], true])('rejects %j', (input) => {
    expect(parseDidDocument(input, DID)).toEqual({ ok: false, reason: 'not-an-object' })
  })
})
