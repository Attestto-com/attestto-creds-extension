import { describe, it, expect } from 'vitest'
import { parseDid, MAX_DID_LENGTH } from './did-syntax'

/**
 * Story 2.1 — `parseDid`.
 *
 * The method allowlist downstream is only as good as the method this function
 * reports, so the adversarial cases here are the ones that try to make `method`
 * disagree with what the rest of the DID will be treated as.
 */
describe('parseDid — valid DIDs', () => {
  it('splits scheme, method and method-specific-id', () => {
    const result = parseDid('did:web:example.com')
    expect(result).toEqual({
      ok: true,
      value: { did: 'did:web:example.com', method: 'web', methodSpecificId: 'example.com' },
    })
  })

  it('keeps colons inside the method-specific-id', () => {
    const result = parseDid('did:web:example.com:users:alice')
    expect(result.ok && result.value.method).toBe('web')
    expect(result.ok && result.value.methodSpecificId).toBe('example.com:users:alice')
  })

  it('accepts percent-encoded idchars', () => {
    const result = parseDid('did:web:example.com%3A8443')
    expect(result.ok).toBe(true)
  })

  it('accepts a did:jwk with a base64url body', () => {
    const result = parseDid('did:jwk:eyJrdHkiOiJFQyJ9')
    expect(result.ok && result.value.method).toBe('jwk')
  })
})

describe('parseDid — rejections', () => {
  it.each([
    ['', 'missing-did-prefix'],
    ['web:example.com', 'missing-did-prefix'],
    ['did:', 'malformed'],
    ['did:web', 'malformed'],
    ['did:web:', 'empty-method-specific-id'],
    ['did:web:example.com:', 'invalid-method-specific-id'],
    ['did::example.com', 'invalid-method'],
    // Uppercase is not in the method ABNF at all.
    ['did:WEB:example.com', 'invalid-method'],
    ['did:we b:example.com', 'invalid-method'],
    ['did:web-3:example.com', 'invalid-method'],
    // Characters outside idchar.
    ['did:web:exa mple.com', 'invalid-method-specific-id'],
    ['did:web:exa$mple.com', 'invalid-method-specific-id'],
    ['did:web:exa%zzmple.com', 'invalid-method-specific-id'],
  ])('rejects %j as %s', (input, reason) => {
    expect(parseDid(input)).toEqual({ ok: false, reason })
  })

  it.each([null, undefined, 42, {}, [], true])('rejects the non-string %j', (input) => {
    expect(parseDid(input)).toEqual({ ok: false, reason: 'not-a-string' })
  })

  it('rejects a DID longer than the cap', () => {
    const long = `did:web:${'a'.repeat(MAX_DID_LENGTH)}`
    expect(parseDid(long)).toEqual({ ok: false, reason: 'too-long' })
  })
})

/**
 * A DID URL carries a fragment/path/query that names something MORE specific
 * than the document. Resolving the base and discarding that part would answer a
 * different question than the caller asked.
 */
describe('parseDid — DID URLs are rejected, never stripped', () => {
  it.each([
    'did:web:example.com#key-1',
    'did:web:example.com/path',
    'did:web:example.com?service=x',
    'did:jwk:eyJrdHkiOiJFQyJ9#0',
  ])('rejects %s', (input) => {
    expect(parseDid(input)).toEqual({ ok: false, reason: 'is-a-did-url' })
  })

  it('does not silently return the base DID for a DID URL', () => {
    const result = parseDid('did:web:example.com#key-1')
    // The mutation this guards: `input.split('#')[0]` before parsing, which
    // would make this `{ok:true, methodSpecificId:'example.com'}`.
    expect(result.ok).toBe(false)
  })
})

/**
 * 🔒 The confusion cases. Each of these, parsed loosely, reports a method that
 * differs from what a later stage would act on.
 */
describe('parseDid — method confusion', () => {
  it('does not let a path segment change the effective method', () => {
    // Loose parsing on "last colon wins" would call this method `web`.
    const result = parseDid('did:jwk:abc:web:evil.example')
    expect(result.ok && result.value.method).toBe('jwk')
  })

  it('does not let a traversal-shaped msid escape the method', () => {
    expect(parseDid('did:jwk:../web:evil.example')).toEqual({
      ok: false,
      reason: 'is-a-did-url',
    })
  })

  it('reports the FIRST method segment, not any later one', () => {
    const result = parseDid('did:web:a.example:did:jwk:xyz')
    expect(result.ok && result.value.method).toBe('web')
    expect(result.ok && result.value.methodSpecificId).toBe('a.example:did:jwk:xyz')
  })
})
