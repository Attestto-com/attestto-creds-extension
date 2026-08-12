import { describe, it, expect } from 'vitest'
import {
  MESSAGING_PROFILE,
  SUPPORTED_VP_FORMATS,
  SUPPORTED_RESPONSE_MODES,
  isSupportedVpFormat,
  isSupportedResponseMode,
  isSupportedClientIdScheme,
  describeProfile,
} from './profile'

/**
 * Story 2.7 — the single messaging-profile module, written test-first.
 *
 * The point of this module is that there is exactly ONE place naming the
 * transport and its parameters. Its value is entirely in being the only source,
 * so the tests that matter are the ones that would catch a SECOND source
 * appearing — those live in `profile.no-hardcoding.spec.ts`. These pin the
 * contract itself.
 */
describe('MESSAGING_PROFILE — the declared transport', () => {
  it('declares OID4VP over REST, not DIDComm', () => {
    // The recorded cross-product decision: DIDComm was a borrowed vocabulary
    // with no wire mechanics behind it in either product, and both
    // implementations were dead placeholders.
    expect(MESSAGING_PROFILE.protocol).toBe('oid4vp')
    expect(MESSAGING_PROFILE.transport).toBe('rest')
  })

  it('pins the OpenID4VP draft it targets', () => {
    // A profile that does not say WHICH draft cannot be conformance-tested
    // against an independent verifier (Story 2.5).
    expect(MESSAGING_PROFILE.specVersion).toBe('openid4vp-1.0')
  })

  it('is deeply frozen so no caller can mutate the shared profile', () => {
    expect(Object.isFrozen(MESSAGING_PROFILE)).toBe(true)
    expect(Object.isFrozen(MESSAGING_PROFILE.vpFormats)).toBe(true)
    expect(Object.isFrozen(MESSAGING_PROFILE.responseModes)).toBe(true)
    expect(Object.isFrozen(MESSAGING_PROFILE.clientIdSchemes)).toBe(true)
  })
})

describe('supported VP formats', () => {
  it('declares the formats this wallet can actually produce', () => {
    // Each of these has a real producer in src/services: jws.ts (jwt_vp),
    // sdjwt.ts (dc+sd-jwt), jsonld-vp.ts (ldp_vp). Advertising a format with no
    // producer means agreeing to a presentation we then fail to build.
    expect([...SUPPORTED_VP_FORMATS].sort()).toEqual(['dc+sd-jwt', 'jwt_vp', 'ldp_vp'])
  })

  it('accepts a declared format and rejects anything else', () => {
    expect(isSupportedVpFormat('jwt_vp')).toBe(true)
    expect(isSupportedVpFormat('ldp_vp')).toBe(true)
    expect(isSupportedVpFormat('mso_mdoc')).toBe(false)
    expect(isSupportedVpFormat('')).toBe(false)
  })

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'does not admit the inherited member %s as a format',
    (name) => {
      // The same fail-open that bit peer-verification.ts: a name-keyed lookup
      // reaching Object.prototype. Pinned here so this module cannot repeat it.
      expect(isSupportedVpFormat(name)).toBe(false)
    },
  )

  it.each([null, undefined, 42, {}, []])('rejects the non-string %j', (value) => {
    expect(isSupportedVpFormat(value)).toBe(false)
  })
})

describe('supported response modes', () => {
  it('declares direct_post only', () => {
    // `fragment` and `query` return the vp_token through the URL, where it lands
    // in browser history and Referer. A presentation is bearer-shaped
    // credential material; it does not go in a URL.
    expect([...SUPPORTED_RESPONSE_MODES]).toEqual(['direct_post'])
  })

  it('🔒 rejects the URL-carrying response modes', () => {
    expect(isSupportedResponseMode('fragment')).toBe(false)
    expect(isSupportedResponseMode('query')).toBe(false)
    expect(isSupportedResponseMode('direct_post.jwt')).toBe(false)
  })

  it('accepts direct_post', () => {
    expect(isSupportedResponseMode('direct_post')).toBe(true)
  })

  it.each([null, undefined, 42, 'toString'])('rejects %j', (value) => {
    expect(isSupportedResponseMode(value)).toBe(false)
  })
})

describe('supported client_id schemes', () => {
  it('admits only schemes whose authority can be checked', () => {
    // `redirect_uri` lets a verifier assert an identity that nothing verifies.
    // `did` resolves through the Story 2.1 resolver; `x509_san_dns` binds to a
    // certificate. Both have an external referent; `redirect_uri` has none.
    expect([...MESSAGING_PROFILE.clientIdSchemes].sort()).toEqual(['did', 'x509_san_dns'])
  })

  it('🔒 rejects the redirect_uri scheme', () => {
    expect(isSupportedClientIdScheme('redirect_uri')).toBe(false)
  })

  it('accepts did', () => {
    expect(isSupportedClientIdScheme('did')).toBe(true)
  })

  it.each([null, undefined, '', 'valueOf'])('rejects %j', (value) => {
    expect(isSupportedClientIdScheme(value)).toBe(false)
  })
})

describe('describeProfile — what the wallet advertises', () => {
  it('reports the profile as a plain serializable object', () => {
    const described = describeProfile()
    expect(JSON.parse(JSON.stringify(described))).toEqual(described)
  })

  it('advertises exactly what the predicates accept — no drift', () => {
    // The referent that matters: if someone adds a format to the advertised
    // description without adding a producer, or vice versa, these disagree.
    const described = describeProfile()
    for (const format of described.vp_formats) {
      expect(isSupportedVpFormat(format), `advertised ${format} is not accepted`).toBe(true)
    }
    for (const mode of described.response_modes_supported) {
      expect(isSupportedResponseMode(mode), `advertised ${mode} is not accepted`).toBe(true)
    }
    expect(described.vp_formats.length).toBe(SUPPORTED_VP_FORMATS.length)
    expect(described.response_modes_supported.length).toBe(SUPPORTED_RESPONSE_MODES.length)
  })

  it('returns a fresh object each call so a caller cannot poison the shared one', () => {
    const a = describeProfile()
    const b = describeProfile()
    expect(a).not.toBe(b)
    a.vp_formats.push('mso_mdoc')
    expect(describeProfile().vp_formats).not.toContain('mso_mdoc')
  })
})
