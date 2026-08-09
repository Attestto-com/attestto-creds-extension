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
function parsePublicJwk(value: unknown): JsonWebKey | null {
  if (!isRecord(value)) return null
  if ('d' in value) return null

  const { kty, crv, x, y } = value
  if (typeof kty !== 'string' || typeof crv !== 'string' || typeof x !== 'string') return null
  // base64url, no padding — the only encoding a JWK coordinate may use.
  const isB64Url = (s: string): boolean => /^[A-Za-z0-9_-]+$/.test(s)
  if (!isB64Url(x)) return null

  if (kty === 'EC' && crv === 'P-256') {
    if (typeof y !== 'string' || !isB64Url(y)) return null
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
 * The DID spec also allows an EMBEDDED method object in these arrays. We drop
 * embedded entries deliberately: an embedded key that appears in no
 * `verificationMethod` list is a key with no independent definition, and
 * supporting it would mean two code paths that can disagree about which keys a
 * document contains.
 */
function parseRelationship(value: unknown, knownIds: ReadonlySet<string>): readonly string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && knownIds.has(entry)) out.push(entry)
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

  const rawMethods = value.verificationMethod
  if (!Array.isArray(rawMethods) || rawMethods.length === 0) {
    return { ok: false, reason: 'no-verification-methods' }
  }
  if (rawMethods.length > MAX_VERIFICATION_METHODS) {
    return { ok: false, reason: 'too-many-verification-methods' }
  }

  const methods: VerificationMethod[] = []
  for (const raw of rawMethods) {
    const method = parseVerificationMethod(raw, expectedDid)
    // Fail the whole document rather than skipping the bad entry: a document
    // with one unparseable method is a document we do not understand, and
    // silently resolving a SUBSET of the keys means a later "this key is not in
    // the document" verdict could be an artefact of our own parser.
    if (method === null) return { ok: false, reason: 'invalid-verification-method' }
    methods.push(method)
  }

  const knownIds = new Set(methods.map((m) => m.id))

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
