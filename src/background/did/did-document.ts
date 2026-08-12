/**
 * Story 2.1 — DID document parsing. Pure, total, and PARSING rather than casting
 * (FR16c): callers receive a `DidDocument` whose fields have each been checked,
 * never the raw JSON with a type annotation stapled on.
 *
 * ── The control that matters most is `id` ──────────────────────────────────
 *
 * `parseDidDocument` takes the DID that was ASKED FOR and requires the document
 * to claim exactly that `id`. Without it, "resolve" degrades into "fetch some
 * JSON from a host the DID names and believe it", and any endpoint that can
 * return a JSON body can hand back a document full of keys it does not control.
 * That is the resolve-then-trust bug the AD-9 port comment names, and the `id`
 * check is the single line that closes it — so it is asserted here, at the only
 * place a document is constructed, rather than left to each caller to remember.
 *
 * Unknown top-level properties are DROPPED, not preserved. A DID document is
 * consumed downstream to answer "does this key belong to this DID"; carrying
 * along attacker-authored fields (`proof`, `alsoKnownAs`, a second `@context`)
 * only creates opportunities for a later reader to trust one of them.
 */

/** A verification method we were able to fully validate. */
export interface VerificationMethod {
  id: string
  type: string
  controller: string
  publicKeyJwk: JsonWebKey
}

/** The subset of a DID document this extension acts on. */
export interface DidDocument {
  id: string
  verificationMethod: readonly VerificationMethod[]
  /** Verification-method IDs usable for authentication. */
  authentication: readonly string[]
  /** Verification-method IDs usable for assertions. */
  assertionMethod: readonly string[]
}

export type DidDocumentReason =
  | 'not-an-object'
  | 'id-mismatch'
  | 'no-verification-methods'
  | 'invalid-verification-method'
  | 'too-many-verification-methods'
  | 'duplicate-verification-method-id'

export type ParseDidDocumentResult =
  | { ok: true; value: DidDocument }
  | { ok: false; reason: DidDocumentReason }

/**
 * A document with hundreds of keys is not a real identity; it is either a
 * mistake or an attempt to make downstream key-matching expensive.
 */
export const MAX_VERIFICATION_METHODS = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a public JWK. Only P-256 and Ed25519 are admitted — the two curves
 * this extension actually verifies with (`crypto.subtle` ECDSA P-256, and
 * Ed25519 for DIDComm). Admitting a curve we cannot verify would let a document
 * advertise a key that silently fails closed much later, at signature time,
 * where the cause is far harder to see.
 *
 * A `d` member means a PRIVATE key arrived in a public document. That is never
 * legitimate, and copying it into our record would put someone else's secret in
 * our vault — reject the whole method.
 */
/**
 * base64url length of a 32-byte coordinate, unpadded: ceil(32 * 4 / 3) = 43.
 *
 * 🩸 Review finding. The first version validated only the ALPHABET, so `x: 'A'`
 * was accepted for P-256, and `x: 'AAAAA'` (length ≡ 1 mod 4, not decodable as
 * base64 at all) was too. That reproduced exactly the failure this function's
 * own header claims to prevent — a key that sails through here and fails much
 * later at signature time, where the cause is far harder to find.
 */
const COORD_LENGTH_32_BYTES = 43

function parsePublicJwk(value: unknown): JsonWebKey | null {
  if (!isRecord(value)) return null
  if ('d' in value) return null

  const { kty, crv, x, y } = value
  if (typeof kty !== 'string' || typeof crv !== 'string' || typeof x !== 'string') return null
  // base64url, no padding, and the exact length the curve requires.
  const isCoord = (s: string): boolean =>
    /^[A-Za-z0-9_-]+$/.test(s) && s.length === COORD_LENGTH_32_BYTES
  if (!isCoord(x)) return null

  if (kty === 'EC' && crv === 'P-256') {
    if (typeof y !== 'string' || !isCoord(y)) return null
    return { kty, crv, x, y }
  }
  if (kty === 'OKP' && crv === 'Ed25519') {
    // OKP keys have no `y`; one present means the document is malformed or is
    // describing a different key type than it claims.
    if (y !== undefined) return null
    return { kty, crv, x }
  }
  return null
}

/**
 * A verification method's `id` must be scoped to the document's subject. A
 * document for `did:web:a.example` listing a method `did:web:b.example#k` is
 * claiming authority over another DID's key — reject rather than store it.
 */
function parseVerificationMethod(value: unknown, documentId: string): VerificationMethod | null {
  if (!isRecord(value)) return null
  const { id, type, controller, publicKeyJwk } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof type !== 'string' || type.length === 0) return null
  if (typeof controller !== 'string' || controller.length === 0) return null

  if (id !== documentId && !id.startsWith(`${documentId}#`)) return null
  if (controller !== documentId) return null

  const jwk = parsePublicJwk(publicKeyJwk)
  if (jwk === null) return null

  return { id, type, controller, publicKeyJwk: jwk }
}

/**
 * Read a relationship array (`authentication`, `assertionMethod`), keeping only
 * string references that point at a method this document actually defines.
 *
 * Embedded method objects are also accepted: `parseDidDocument` has already
 * promoted them into the single method list, so they are referenced here by
 * their own id. There is still ONE list of keys — no second code path that
 * could disagree about what the document contains.
 */
function parseRelationship(value: unknown, knownIds: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    // A string reference to a method this document defines...
    if (typeof entry === 'string' && knownIds.has(entry)) {
      out.push(entry)
      continue
    }
    // ...or an EMBEDDED method, which `parseDidDocument` has already promoted
    // into the single method list, so it is referenced here by its own id.
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).id
      if (typeof id === 'string' && knownIds.has(id)) out.push(id)
    }
  }
  return out
}

/**
 * Parse an untrusted value into a `DidDocument` for `expectedDid`.
 *
 * `expectedDid` is REQUIRED — there is no overload that parses a document
 * without knowing which DID it should describe, because that overload is the
 * one every resolve-then-trust bug is written with.
 */
export function parseDidDocument(value: unknown, expectedDid: string): ParseDidDocumentResult {
  if (!isRecord(value)) return { ok: false, reason: 'not-an-object' }

  // 🔒 The document must claim the DID we asked for. Nothing else in this
  // function matters if this check is absent.
  if (value.id !== expectedDid) return { ok: false, reason: 'id-mismatch' }

  /**
   * 🩸 Review finding (interop). The spec also allows a verification method to
   * be EMBEDDED as an object inside a relationship array, with no top-level
   * `verificationMethod` entry. The first version ignored embedded methods
   * entirely, which produced two wrong outcomes on documents that are perfectly
   * valid: a document whose only key is embedded was rejected as
   * `no-verification-methods`, and a document with both forms came back with
   * `authentication: []` — turning "we do not read this shape" into the
   * materially different claim "this DID has no authentication key", which
   * `senderResolvable` then acted on.
   *
   * Embedded methods are collected here and treated exactly like top-level
   * ones, so there is still ONE list of keys and no second code path that could
   * disagree about what a document contains.
   */
  const rawTop = Array.isArray(value.verificationMethod) ? value.verificationMethod : []
  const embedded: unknown[] = []
  for (const key of ['authentication', 'assertionMethod'] as const) {
    const arr = value[key]
    if (Array.isArray(arr)) {
      for (const entry of arr) if (isRecord(entry)) embedded.push(entry)
    }
  }

  const rawMethods = [...rawTop, ...embedded]
  if (rawMethods.length === 0) {
    return { ok: false, reason: 'no-verification-methods' }
  }
  if (rawMethods.length > MAX_VERIFICATION_METHODS) {
    return { ok: false, reason: 'too-many-verification-methods' }
  }

  const methods: VerificationMethod[] = []
  const seenIds = new Set<string>()
  for (const raw of rawMethods) {
    const method = parseVerificationMethod(raw, expectedDid)
    // Fail the whole document rather than skipping the bad entry: a document
    // with one unparseable method is a document we do not understand, and
    // silently resolving a SUBSET of the keys means a later "this key is not in
    // the document" verdict could be an artefact of our own parser.
    if (method === null) return { ok: false, reason: 'invalid-verification-method' }
    // 🩸 Review finding. Duplicate ids carrying DIFFERENT keys were both kept,
    // so which key a consumer got depended on document order — key-substitution
    // ambiguity waiting for its first consumer. An id must name one key.
    if (seenIds.has(method.id)) {
      const first = methods.find((m) => m.id === method.id)
      if (JSON.stringify(first?.publicKeyJwk) !== JSON.stringify(method.publicKeyJwk)) {
        return { ok: false, reason: 'duplicate-verification-method-id' }
      }
      continue // an exact repeat is redundant, not ambiguous
    }
    seenIds.add(method.id)
    methods.push(method)
  }

  const knownIds = seenIds

  return {
    ok: true,
    value: {
      id: expectedDid,
      verificationMethod: methods,
      authentication: parseRelationship(value.authentication, knownIds),
      assertionMethod: parseRelationship(value.assertionMethod, knownIds),
    },
  }
}
