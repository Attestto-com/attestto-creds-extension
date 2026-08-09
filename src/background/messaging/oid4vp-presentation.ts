/**
 * Story 2.4 — building the OID4VP `direct_post` response.
 *
 * Pure: takes a `JwsSigner`, returns a body. No `chrome.*`, no `fetch`, no key
 * import (AD-11c — the background's ONE gated signing primitive supplies the
 * signer; this module never touches key material).
 *
 * ── The approved set IS the disclosed set ──────────────────────────────────
 *
 * Story 1.17 found `approvedFields` being RECORDED and then IGNORED on the
 * JSON-LD path: the stored consent record said two claims while the wire
 * carried every claim in the credential. The audit trail and the payload
 * disagreed, which makes the record worse than useless — it is affirmative
 * evidence of something that did not happen.
 *
 * So disclosure here is driven by `approvedClaims` and nothing else, and
 * approval cannot WIDEN the request: an approved claim that was never requested
 * is refused rather than sent. That direction matters. A compromised or buggy
 * consent screen can then only ever cause LESS to be disclosed than the
 * verifier asked for, never more.
 *
 * ── Replay binding ─────────────────────────────────────────────────────────
 *
 * `nonce` and `aud` go INSIDE the signed payload. A nonce attached to the POST
 * body alongside the token binds nothing — the token would remain replayable at
 * any other verifier. `signCompactJws` signs the exact bytes it emits, so what
 * is signed is provably what is sent.
 *
 * ── The issuer proof, on partial disclosure ────────────────────────────────
 *
 * JSON-LD has no cryptographic selective disclosure, so removing a claim
 * invalidates the issuer's signature over the credential. `deriveDisclosedCredential`
 * therefore drops the proof and marks the result derived. That is a real
 * tradeoff recorded in Story 1.17 and still open: most verifiers will reject a
 * credential with no issuer proof. The alternative — refusing partial
 * disclosure on this format — is a two-line change. It is asserted by a test
 * here so it stays a KNOWN property rather than something a verifier discovers.
 */
import { signCompactJws, type JwsSigner } from '@/services/jws'
import { deriveDisclosedCredential } from '@/services/jsonld-disclosure'
import type { AuthorizationRequest } from './oid4vp-request'
import { MESSAGING_PROFILE } from './profile'

export type PresentationReason =
  | 'no-approved-claims'
  | 'approved-claim-not-requested'
  | 'unsupported-claim-path'
  | 'signing-failed'

export interface PresentationSubmission {
  id: string
  definition_id: string
  descriptor_map: { id: string; format: string; path: string }[]
}

/** Exactly the fields a `direct_post` body may carry. */
export interface DirectPostBody {
  vp_token: string
  presentation_submission: PresentationSubmission
  state?: string
}

export type BuildPresentationResult =
  | { ok: true; value: DirectPostBody }
  | { ok: false; reason: PresentationReason }

export interface BuildPresentationInput {
  request: AuthorizationRequest
  /** Claims the USER approved. Must be a subset of `request.requestedClaims`. */
  approvedClaims: readonly string[]
  credential: Record<string, unknown>
  holderDid: string
  sign: JwsSigner
}

const SUBJECT_PREFIX = '$.credentialSubject.'

/**
 * Map a DIF claim path to the `credentialSubject` field it names.
 *
 * Only single-level subject paths are supported, and anything else returns
 * null so the caller can REFUSE rather than guess. A silent "could not map, so
 * disclose nothing here" would let a request for `$.credentialSubject.a.b`
 * produce a presentation that quietly omits it — the verifier then sees a
 * response that looks complete and is not.
 */
export function claimToSubjectField(path: string): string | null {
  if (!path.startsWith(SUBJECT_PREFIX)) return null
  const field = path.slice(SUBJECT_PREFIX.length)
  if (field.length === 0) return null
  // Nested paths are not modelled; `deriveDisclosedCredential` selects top-level
  // subject keys only.
  if (field.includes('.') || field.includes('[')) return null
  return field
}

export async function buildPresentationResponse(
  input: BuildPresentationInput,
): Promise<BuildPresentationResult> {
  const { request, approvedClaims, credential, holderDid, sign } = input

  if (approvedClaims.length === 0) return { ok: false, reason: 'no-approved-claims' }

  // 🔒 Approval may narrow the request, never widen it.
  const requested = new Set(request.requestedClaims)
  for (const claim of approvedClaims) {
    if (!requested.has(claim)) return { ok: false, reason: 'approved-claim-not-requested' }
  }

  const fields: string[] = []
  for (const claim of approvedClaims) {
    const field = claimToSubjectField(claim)
    if (field === null) return { ok: false, reason: 'unsupported-claim-path' }
    fields.push(field)
  }

  // Disclosure is driven ONLY by the approved set.
  const derived = deriveDisclosedCredential(credential, fields, { holderDid })

  const vp = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    holder: holderDid,
    verifiableCredential: [derived.credential],
  }

  let vpToken: string
  try {
    vpToken = await signCompactJws(
      { alg: 'ES256', typ: 'JWT' },
      {
        iss: holderDid,
        sub: holderDid,
        // 🔒 Inside the signature. Alongside it would bind nothing.
        aud: request.clientId,
        nonce: request.nonce,
        vp,
      },
      sign,
    )
  } catch {
    // No unsigned fallback: a presentation without a holder signature is not a
    // presentation, and emitting one would be worse than failing.
    return { ok: false, reason: 'signing-failed' }
  }

  const body: DirectPostBody = {
    vp_token: vpToken,
    presentation_submission: {
      id: `sub-${request.nonce.slice(0, 8)}`,
      definition_id: 'pd',
      descriptor_map: [
        // The format is read from the profile rather than written inline, so
        // this module does not become a second source of the vocabulary.
        { id: 'vp', format: MESSAGING_PROFILE.vpFormats[0], path: '$' },
      ],
    },
  }

  // Absent rather than null: OpenID4VP says echo `state` if it was present, and
  // a null would be an assertion that the verifier sent one.
  if (request.state !== null) body.state = request.state

  return { ok: true, value: body }
}
