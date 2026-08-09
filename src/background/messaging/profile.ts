/**
 * Story 2.7 — the single messaging-profile module.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Before this, the transport was implied in three places that did not agree:
 * `services/didcomm.ts` borrowed DIDComm/Present-Proof vocabulary while
 * implementing none of its wire mechanics (no JWE envelope, no key agreement,
 * no endpoint resolution), a route was named `DIDCOMM_INBOUND`, and the actual
 * plan of record was OID4VP over REST. Both DIDComm implementations across the
 * product turned out to be dead placeholders. A reader could not tell from the
 * code which protocol the wallet spoke.
 *
 * Everything about the transport is declared HERE, once. A second place naming
 * a format string, a response mode, or a client_id scheme is a bug, and
 * `profile.no-hardcoding.spec.ts` is the guard that says so.
 *
 * ── Two deliberate narrowings ──────────────────────────────────────────────
 *
 * The profile is smaller than OpenID4VP permits, in both cases because the
 * excluded option removes a control rather than adding a capability:
 *
 * `response_mode`: **direct_post only.** `fragment` and `query` return the
 *   `vp_token` in the URL. A presentation is bearer-shaped credential material,
 *   and a URL lands in browser history, in `Referer`, in server logs, and in
 *   the address bar. Supporting them would mean the wallet's disclosure
 *   guarantees depend on where the verifier chose to put the response.
 *
 * `client_id_scheme`: **no `redirect_uri`.** Under that scheme the verifier's
 *   claimed identity is a URL it supplies about itself, with nothing to check it
 *   against — the consent screen would name a party no one authenticated. `did`
 *   resolves through the Story 2.1 resolver and `x509_san_dns` binds to a
 *   certificate; both have an external referent. This codebase has repeatedly
 *   shipped controls whose only referent was the thing they checked, and this
 *   is the same shape.
 */

/** VP formats this wallet can actually PRODUCE — each has a real producer. */
export const SUPPORTED_VP_FORMATS = Object.freeze([
  'jwt_vp', // src/services/jws.ts
  'ldp_vp', // src/services/jsonld-vp.ts
  'dc+sd-jwt', // src/services/sdjwt.ts
] as const)

export type SupportedVpFormat = (typeof SUPPORTED_VP_FORMATS)[number]

/** Response modes accepted from a verifier. See the narrowing note above. */
export const SUPPORTED_RESPONSE_MODES = Object.freeze(['direct_post'] as const)

export type SupportedResponseMode = (typeof SUPPORTED_RESPONSE_MODES)[number]

/** client_id schemes whose authority can be independently checked. */
export const SUPPORTED_CLIENT_ID_SCHEMES = Object.freeze(['did', 'x509_san_dns'] as const)

export type SupportedClientIdScheme = (typeof SUPPORTED_CLIENT_ID_SCHEMES)[number]

export interface MessagingProfile {
  readonly protocol: 'oid4vp'
  readonly transport: 'rest'
  /** The draft this wallet is conformance-tested against (Story 2.5). */
  readonly specVersion: 'openid4vp-1.0'
  readonly vpFormats: readonly SupportedVpFormat[]
  readonly responseModes: readonly SupportedResponseMode[]
  readonly clientIdSchemes: readonly SupportedClientIdScheme[]
}

/**
 * The profile. Frozen at every level — a shared mutable config is a capability
 * any module holding a reference could widen at runtime.
 */
export const MESSAGING_PROFILE: MessagingProfile = Object.freeze({
  protocol: 'oid4vp',
  transport: 'rest',
  specVersion: 'openid4vp-1.0',
  vpFormats: SUPPORTED_VP_FORMATS,
  responseModes: SUPPORTED_RESPONSE_MODES,
  clientIdSchemes: SUPPORTED_CLIENT_ID_SCHEMES,
} as const)

/**
 * Membership tests over a frozen list rather than a keyed object lookup.
 *
 * `readonly string[].includes()` cannot reach `Object.prototype`, so
 * `isSupportedVpFormat('toString')` is false by construction. That is not an
 * incidental detail: the first draft of `peer-verification.ts` used a keyed
 * lookup and `PEER_CHECKS['toString']` returned `Object.prototype.toString` — a
 * function, which passed a `typeof` guard and returned a truthy string. Array
 * membership has no such surface.
 */
function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

export function isSupportedVpFormat(value: unknown): value is SupportedVpFormat {
  return isMember(SUPPORTED_VP_FORMATS, value)
}

export function isSupportedResponseMode(value: unknown): value is SupportedResponseMode {
  return isMember(SUPPORTED_RESPONSE_MODES, value)
}

export function isSupportedClientIdScheme(value: unknown): value is SupportedClientIdScheme {
  return isMember(SUPPORTED_CLIENT_ID_SCHEMES, value)
}

/** What the wallet advertises about itself, in OpenID4VP's snake_case naming. */
export interface ProfileDescription {
  protocol: string
  spec_version: string
  vp_formats: string[]
  response_modes_supported: string[]
  client_id_schemes_supported: string[]
}

/**
 * A fresh, plain, serializable description each call.
 *
 * Fresh because a caller that mutated a shared array would silently widen what
 * every later caller advertises. The arrays are copies, not the frozen originals.
 */
export function describeProfile(): ProfileDescription {
  return {
    protocol: MESSAGING_PROFILE.protocol,
    spec_version: MESSAGING_PROFILE.specVersion,
    vp_formats: [...MESSAGING_PROFILE.vpFormats],
    response_modes_supported: [...MESSAGING_PROFILE.responseModes],
    client_id_schemes_supported: [...MESSAGING_PROFILE.clientIdSchemes],
  }
}
