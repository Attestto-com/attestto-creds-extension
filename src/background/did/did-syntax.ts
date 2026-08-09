/**
 * Story 2.1 — DID syntax parsing (W3C DID Core ABNF, §3.1).
 *
 * Pure and total: every input either yields a `ParsedDid` or a `reason` code.
 * Nothing here touches the network or `chrome.*`.
 *
 * Why this is its own module rather than a regex at the resolver's call site:
 * the resolver's method allowlist is only meaningful if the METHOD it checks is
 * the method the rest of the pipeline will act on. A permissive parse that lets
 * `did:jwk:x#../../web:evil.example` through as method `jwk` would pass an
 * allowlist of `['jwk']` and then be handed to a `did:web` URL builder by a
 * later refactor. Parse once, narrowly, and carry the parts.
 *
 * ── DID URLs are REJECTED, not stripped ────────────────────────────────────
 *
 * `did:web:example.com#key-1` is a DID *URL*, not a DID. Stripping the fragment
 * and resolving the base would mean `resolve()` silently answers a question it
 * was not asked — the caller wanted a specific verification method and got a
 * whole document. Callers that hold a DID URL must split it themselves, so the
 * discarded part is visible in their code rather than swallowed in ours.
 */

/** The parts of a syntactically valid DID. */
export interface ParsedDid {
  /** The full DID, unchanged. */
  did: string
  /** Lowercase method name, e.g. `jwk`, `web`. */
  method: string
  /** Method-specific identifier — everything after `did:<method>:`. */
  methodSpecificId: string
}

export type DidSyntaxReason =
  | 'not-a-string'
  | 'too-long'
  | 'missing-did-prefix'
  | 'malformed'
  | 'invalid-method'
  | 'empty-method-specific-id'
  | 'invalid-method-specific-id'
  | 'is-a-did-url'

export type ParseDidResult =
  | { ok: true; value: ParsedDid }
  | { ok: false; reason: DidSyntaxReason }

/**
 * Upper bound on a DID we will even look at. The ABNF has no length limit, but
 * an unbounded identifier is an unbounded cache key and an unbounded URL. 2048
 * comfortably fits a `did:jwk` carrying a P-384 key (~200 chars) with room to
 * spare; anything approaching this is not a real identifier.
 */
export const MAX_DID_LENGTH = 2048

// method = 1*method-char ; method-char = %x61-7A / DIGIT  (lowercase only —
// the ABNF admits no uppercase, so `did:WEB:` is malformed, not a case variant.)
const METHOD_RE = /^[a-z0-9]+$/

// idchar = ALPHA / DIGIT / "." / "-" / "_" / pct-encoded
// method-specific-id = *( *idchar ":" ) 1*idchar
// Trailing ":" is invalid; empty segments between colons ARE permitted by the
// ABNF (`*idchar`), which `did:web` relies on for nothing but which we must not
// reject or we would be stricter than the spec for no security gain.
const IDCHAR_SEGMENT_RE = /^(?:[A-Za-z0-9.\-_]|%[0-9A-Fa-f]{2})*$/

/** Characters that turn a DID into a DID URL (path / query / fragment). */
const DID_URL_CHARS = ['/', '?', '#']

/**
 * Parse a DID into its parts, or explain why it is not one.
 *
 * Fail-closed: an unrecognised shape is an error, never a best-effort guess.
 */
export function parseDid(input: unknown): ParseDidResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' }
  if (input.length > MAX_DID_LENGTH) return { ok: false, reason: 'too-long' }

  // Checked BEFORE the prefix test so `https://evil.example/did:web:x` reports
  // the informative reason rather than the generic prefix miss.
  if (DID_URL_CHARS.some((c) => input.includes(c))) {
    return { ok: false, reason: 'is-a-did-url' }
  }

  if (!input.startsWith('did:')) return { ok: false, reason: 'missing-did-prefix' }

  // Split into exactly three parts: scheme, method, and the rest (which may
  // itself contain colons — `did:web:example.com:user:alice`).
  const firstColon = input.indexOf(':')
  const secondColon = input.indexOf(':', firstColon + 1)
  if (secondColon === -1) return { ok: false, reason: 'malformed' }

  const method = input.slice(firstColon + 1, secondColon)
  const methodSpecificId = input.slice(secondColon + 1)

  if (!METHOD_RE.test(method)) return { ok: false, reason: 'invalid-method' }
  if (methodSpecificId.length === 0) return { ok: false, reason: 'empty-method-specific-id' }
  // A trailing colon leaves an empty final segment, which the ABNF's closing
  // `1*idchar` forbids.
  if (methodSpecificId.endsWith(':')) return { ok: false, reason: 'invalid-method-specific-id' }

  for (const segment of methodSpecificId.split(':')) {
    if (!IDCHAR_SEGMENT_RE.test(segment)) {
      return { ok: false, reason: 'invalid-method-specific-id' }
    }
  }

  return { ok: true, value: { did: input, method, methodSpecificId } }
}
