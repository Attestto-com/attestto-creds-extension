import { describe, it, expect } from 'vitest'
import { parseAuthorizationRequest, MAX_REQUESTED_CLAIMS } from './oid4vp-request'

/**
 * Story 2.4 — the OID4VP authorization request parser, written test-first.
 *
 * This is the untrusted-input boundary for the whole presentation flow: a
 * verifier (or anything posing as one) hands us a request, and what we do next
 * is show a consent screen naming a party and then POST credential material to
 * an endpoint. Both of those are attacker-influenced unless this function says
 * otherwise, so it PARSES rather than casts (FR16c) and fails closed.
 */

const DID = 'did:web:verifier.example.org'

function request(over: Record<string, unknown> = {}) {
  return {
    client_id: DID,
    client_id_scheme: 'did',
    response_type: 'vp_token',
    response_mode: 'direct_post',
    response_uri: 'https://verifier.example.org/present',
    nonce: 'n-0S6_WzA2Mj-KtR9x',
    state: 'af0ifjsldkj',
    presentation_definition: {
      id: 'pd-1',
      input_descriptors: [
        {
          id: 'id-card',
          constraints: { fields: [{ path: ['$.credentialSubject.name'] }] },
        },
      ],
    },
    ...over,
  }
}

describe('parseAuthorizationRequest — a well-formed request', () => {
  it('returns the normalized request', () => {
    const result = parseAuthorizationRequest(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.clientId).toBe(DID)
    expect(result.value.clientIdScheme).toBe('did')
    expect(result.value.responseMode).toBe('direct_post')
    expect(result.value.responseUri).toBe('https://verifier.example.org/present')
    expect(result.value.nonce).toBe('n-0S6_WzA2Mj-KtR9x')
    expect(result.value.state).toBe('af0ifjsldkj')
    expect(result.value.requestedClaims).toEqual(['$.credentialSubject.name'])
  })

  it('drops unknown top-level parameters rather than carrying them through', () => {
    const result = parseAuthorizationRequest(request({ evil_param: 'PAYLOAD', trust_me: true }))
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PAYLOAD')
    expect(JSON.stringify(result)).not.toContain('trust_me')
  })

  it('treats a missing state as absent, not as empty', () => {
    const { state: _s, ...withoutState } = request()
    const result = parseAuthorizationRequest(withoutState)
    expect(result.ok && result.value.state).toBeNull()
  })
})

/**
 * 🔒 The profile is the authority. A request naming a mode or scheme the
 * profile excludes must be refused HERE, not somewhere downstream.
 */
describe('parseAuthorizationRequest — profile enforcement', () => {
  it.each([
    ['fragment', 'unsupported-response-mode'],
    ['query', 'unsupported-response-mode'],
    ['direct_post.jwt', 'unsupported-response-mode'],
    ['', 'unsupported-response-mode'],
  ])('rejects response_mode %j', (mode, reason) => {
    expect(parseAuthorizationRequest(request({ response_mode: mode }))).toEqual({
      ok: false,
      reason,
    })
  })

  it('🔒 rejects the redirect_uri client_id scheme', () => {
    // Under it the verifier's identity is a URL it asserts about itself, with
    // nothing to check it against — the consent screen would name an
    // unauthenticated party.
    expect(
      parseAuthorizationRequest(
        request({ client_id_scheme: 'redirect_uri', client_id: 'https://verifier.example.org' }),
      ),
    ).toEqual({ ok: false, reason: 'unsupported-client-id-scheme' })
  })

  it('rejects an absent client_id_scheme rather than defaulting', () => {
    const { client_id_scheme: _s, ...noScheme } = request()
    expect(parseAuthorizationRequest(noScheme)).toEqual({
      ok: false,
      reason: 'unsupported-client-id-scheme',
    })
  })

  it('rejects a response_type other than vp_token', () => {
    expect(parseAuthorizationRequest(request({ response_type: 'id_token' }))).toEqual({
      ok: false,
      reason: 'unsupported-response-type',
    })
  })
})

/**
 * 🔒 THE control of this module. `response_uri` is where the vp_token gets
 * POSTed. An unbound one turns any verifier request into an exfiltration
 * instruction pointed wherever it likes.
 */
describe('parseAuthorizationRequest — response_uri is bound to the client', () => {
  it('accepts a response_uri whose host matches the did:web client_id', () => {
    expect(parseAuthorizationRequest(request()).ok).toBe(true)
  })

  it('🔒 rejects a response_uri on a different host from the client_id', () => {
    expect(
      parseAuthorizationRequest(request({ response_uri: 'https://attacker.example.org/collect' })),
    ).toEqual({ ok: false, reason: 'response-uri-not-bound-to-client' })
  })

  it('🔒 rejects a subdomain of the client host', () => {
    // `verifier.example.org.attacker.example` and `evil.verifier.example.org`
    // both "contain" the client host. Binding must be an exact authority match.
    expect(
      parseAuthorizationRequest(
        request({ response_uri: 'https://evil.verifier.example.org/collect' }),
      ),
    ).toEqual({ ok: false, reason: 'response-uri-not-bound-to-client' })
    expect(
      parseAuthorizationRequest(
        request({ response_uri: 'https://verifier.example.org.attacker.example/x' }),
      ),
    ).toEqual({ ok: false, reason: 'response-uri-not-bound-to-client' })
  })

  it.each([
    'http://verifier.example.org/present',
    'ftp://verifier.example.org/present',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
  ])('rejects the non-https response_uri %j', (uri) => {
    const result = parseAuthorizationRequest(request({ response_uri: uri }))
    expect(result.ok).toBe(false)
  })

  it('rejects a missing response_uri under direct_post', () => {
    const { response_uri: _r, ...noUri } = request()
    expect(parseAuthorizationRequest(noUri)).toEqual({ ok: false, reason: 'missing-response-uri' })
  })

  it('rejects userinfo in the response_uri', () => {
    // `https://verifier.example.org@attacker.example/` has authority
    // attacker.example, which a naive prefix check would miss.
    expect(
      parseAuthorizationRequest(
        request({ response_uri: 'https://verifier.example.org@attacker.example/collect' }),
      ),
    ).toEqual({ ok: false, reason: 'response-uri-not-bound-to-client' })
  })

  it('never returns a responseUri whose host differs from the client host', () => {
    // Structural referent: whatever survives is bound, whatever the input.
    for (const uri of [
      'https://attacker.example.org/x',
      'https://evil.verifier.example.org/x',
      'https://verifier.example.org@attacker.example/x',
      'https://verifier.example.org/present',
    ]) {
      const result = parseAuthorizationRequest(request({ response_uri: uri }))
      if (result.ok) {
        expect(new URL(result.value.responseUri).host).toBe('verifier.example.org')
      }
    }
  })
})

describe('parseAuthorizationRequest — client_id must match its scheme', () => {
  it('rejects a did scheme whose client_id is not a DID', () => {
    expect(
      parseAuthorizationRequest(request({ client_id: 'https://verifier.example.org' })),
    ).toEqual({ ok: false, reason: 'client-id-scheme-mismatch' })
  })

  it('rejects a did scheme whose client_id is a malformed DID', () => {
    expect(parseAuthorizationRequest(request({ client_id: 'did:web:' }))).toEqual({
      ok: false,
      reason: 'client-id-scheme-mismatch',
    })
  })

  it('rejects a DID URL as the client_id', () => {
    expect(parseAuthorizationRequest(request({ client_id: `${DID}#key-1` }))).toEqual({
      ok: false,
      reason: 'client-id-scheme-mismatch',
    })
  })

  it('rejects an x509_san_dns scheme whose client_id is not a hostname', () => {
    expect(
      parseAuthorizationRequest(
        request({ client_id_scheme: 'x509_san_dns', client_id: 'not a hostname' }),
      ),
    ).toEqual({ ok: false, reason: 'client-id-scheme-mismatch' })
  })

  it('accepts a well-formed x509_san_dns client bound to its own host', () => {
    const result = parseAuthorizationRequest(
      request({
        client_id_scheme: 'x509_san_dns',
        client_id: 'verifier.example.org',
        response_uri: 'https://verifier.example.org/present',
      }),
    )
    expect(result.ok).toBe(true)
  })
})

/**
 * The nonce is the only replay defence in this flow. A presentation built
 * without one can be replayed against any verifier that accepts it.
 */
describe('parseAuthorizationRequest — nonce', () => {
  it.each([undefined, '', '   ', 42, null])('rejects the nonce %j', (nonce) => {
    const result = parseAuthorizationRequest(request({ nonce }))
    expect(result).toEqual({ ok: false, reason: 'missing-nonce' })
  })

  it('rejects a nonce short enough to be guessable', () => {
    expect(parseAuthorizationRequest(request({ nonce: 'abc' }))).toEqual({
      ok: false,
      reason: 'weak-nonce',
    })
  })

  it('accepts a nonce of adequate length', () => {
    expect(parseAuthorizationRequest(request({ nonce: 'a'.repeat(16) })).ok).toBe(true)
  })
})

describe('parseAuthorizationRequest — presentation definition', () => {
  it('extracts the requested claim paths', () => {
    const result = parseAuthorizationRequest(
      request({
        presentation_definition: {
          id: 'pd',
          input_descriptors: [
            {
              id: 'a',
              constraints: {
                fields: [
                  { path: ['$.credentialSubject.name'] },
                  { path: ['$.credentialSubject.dob'] },
                ],
              },
            },
          ],
        },
      }),
    )
    expect(result.ok && result.value.requestedClaims).toEqual([
      '$.credentialSubject.name',
      '$.credentialSubject.dob',
    ])
  })

  it('deduplicates repeated paths', () => {
    const result = parseAuthorizationRequest(
      request({
        presentation_definition: {
          id: 'pd',
          input_descriptors: [
            {
              id: 'a',
              constraints: {
                fields: [
                  { path: ['$.credentialSubject.name'] },
                  { path: ['$.credentialSubject.name'] },
                ],
              },
            },
          ],
        },
      }),
    )
    expect(result.ok && result.value.requestedClaims).toEqual(['$.credentialSubject.name'])
  })

  it('rejects a request asking for nothing', () => {
    // A consent screen that lists no claims cannot be consented to meaningfully.
    expect(
      parseAuthorizationRequest(
        request({ presentation_definition: { id: 'pd', input_descriptors: [] } }),
      ),
    ).toEqual({ ok: false, reason: 'no-requested-claims' })
  })

  it('rejects a missing presentation_definition', () => {
    const { presentation_definition: _p, ...none } = request()
    expect(parseAuthorizationRequest(none)).toEqual({
      ok: false,
      reason: 'no-requested-claims',
    })
  })

  it('caps the number of requested claims', () => {
    const fields = Array.from({ length: MAX_REQUESTED_CLAIMS + 1 }, (_, i) => ({
      path: [`$.credentialSubject.f${i}`],
    }))
    expect(
      parseAuthorizationRequest(
        request({
          presentation_definition: { id: 'pd', input_descriptors: [{ id: 'a', constraints: { fields } }] },
        }),
      ),
    ).toEqual({ ok: false, reason: 'too-many-requested-claims' })
  })

  it('ignores a malformed field entry rather than trusting it', () => {
    const result = parseAuthorizationRequest(
      request({
        presentation_definition: {
          id: 'pd',
          input_descriptors: [
            {
              id: 'a',
              constraints: {
                fields: [{ path: ['$.credentialSubject.name'] }, { path: 'not-an-array' }, {}, null],
              },
            },
          ],
        },
      }),
    )
    expect(result.ok && result.value.requestedClaims).toEqual(['$.credentialSubject.name'])
  })
})

describe('parseAuthorizationRequest — non-objects', () => {
  it.each([null, undefined, 'str', 42, [], true])('rejects %j', (input) => {
    expect(parseAuthorizationRequest(input)).toEqual({ ok: false, reason: 'not-an-object' })
  })
})
