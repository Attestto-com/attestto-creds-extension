/**
 * Story 1.17 — selective disclosure for JSON-LD credentials.
 *
 * The bug: `createJsonLdVp` embedded the whole VC. In `PresentCredentialView`
 * the JSON-LD branch said, out loud, "All claims will be shared". In
 * `proof-requests.approveRequest` it was worse than that — the user picked
 * fields, the picks were recorded as `approvedFields`, and the JSON-LD branch
 * ignored them. The stored record said the user disclosed two claims while the
 * wire carried all of them. An audit trail that disagrees with the payload is
 * worse than no audit trail.
 *
 * ── The honest part ─────────────────────────────────────────────────────────
 *
 * JSON-LD has no cryptographic selective disclosure. SD-JWT is built for it:
 * each claim is separately salted and hashed, so withholding one leaves the
 * issuer's signature verifiable over what remains. A JSON-LD VC is signed as a
 * whole document. Remove a claim and the issuer's `proof` no longer covers what
 * you are sending.
 *
 * Four things one can do about that, and three of them are bad:
 *
 *   - send everything (the original bug) — the user's choice is a lie
 *   - filter the subject and KEEP the proof — the worst, because the document
 *     carries an issuer signature that does not verify and reads as
 *     issuer-attested to anyone verifying lazily
 *   - filter the subject and DROP the proof — what this module did until
 *     2026-08-09. Private, but it emits a credential-shaped object nothing can
 *     verify: the user consents, believes they shared verified data, and the
 *     rejection arrives after the moment they could have chosen differently
 *   - REFUSE the partial disclosure — what it does now
 *
 * ── The decision, and its cost ──────────────────────────────────────────────
 *
 * Refusing fails at consent time, which is the only point the user can still
 * act on the information. The cost is not small and is not hidden: someone who
 * needs to stay verifiable on this format must now disclose everything, so we
 * are pushing users toward full disclosure. That is a privacy regression of our
 * making, and it is why this is a stopgap rather than a resolution.
 *
 * The resolution is a FORMAT change. SD-JWT gives cryptographic selective
 * disclosure, `src/services/sdjwt.ts` already handles it, and the messaging
 * profile already lists `dc+sd-jwt`. Issuing selectively-disclosable credentials
 * in that format deletes this whole dilemma. Tracked for Phase 2.
 *
 * Selecting everything is unaffected: the document is returned untouched, proof
 * intact. The common case keeps full issuer verifiability.
 */

/**
 * Retained for readers of previously-issued artefacts only. NOTHING in this
 * module emits it any more — partial disclosure is refused rather than
 * downgraded. Kept because documents carrying this marker may exist from before
 * 2026-08-09 and a verifier-side reader still needs to recognise them.
 */
export const DERIVED_TYPE = 'DerivedCredential'

/**
 * The outcome of a disclosure attempt.
 *
 * A DISCRIMINATED result, not a credential plus a `complete` flag. The previous
 * shape returned a usable `credential` alongside `complete: false`, and every
 * caller was free to ignore the flag and send the credential anyway — which is
 * exactly what happened. A refusal that a caller can destructure past is not a
 * refusal. Now there is no `credential` field to reach on the failure branch.
 */
export type DisclosureResult =
  | {
      ok: true
      /** The VC to embed in the VP. Issuer proof intact. */
      credential: Record<string, unknown>
      withheld: never[]
    }
  | {
      ok: false
      reason: 'partial-disclosure-unsupported'
      /** Claim names the user withheld, for an explanatory message. */
      withheld: string[]
    }

export interface DeriveOptions {
  /**
   * The holder's DID. `credentialSubject.id` is preserved when it names the
   * holder: the VP's own `holder` field already reveals that DID, so keeping it
   * discloses nothing new, and dropping it would break the subject↔holder
   * binding a verifier needs to know the presenter is the subject.
   *
   * When the subject id is somebody ELSE (a third-party credential), it is an
   * identifier the user did not choose to share, and it is filtered like any
   * other claim.
   */
  holderDid?: string
}

/**
 * Reduce a JSON-LD VC to the selected claims.
 *
 * `selectedFields` names keys of `credentialSubject` — the same names the UI
 * lists, since `decodedClaims` for a JSON-LD credential IS the credentialSubject.
 */
export function deriveDisclosedCredential(
  vc: Record<string, unknown>,
  selectedFields: readonly string[],
  options: DeriveOptions = {},
): DisclosureResult {
  const subject = vc.credentialSubject
  // No subject to filter (a shape we do not model). Withholding nothing is the
  // truthful answer; it is NOT "disclose everything after claiming otherwise",
  // because there are no subject claims here to withhold.
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    return { ok: true, credential: vc, withheld: [] }
  }

  const source = subject as Record<string, unknown>
  const keepSubjectId =
    typeof source.id === 'string' && options.holderDid !== undefined && source.id === options.holderDid

  const requested = new Set(selectedFields)
  if (keepSubjectId) requested.add('id')

  const withheld = Object.keys(source).filter((key) => !requested.has(key))
  if (withheld.length === 0) {
    // Nothing removed: the issuer's signature still covers the whole document.
    return { ok: true, credential: vc, withheld: [] }
  }

  /**
   * 🛑 REFUSED. Decision 2026-08-09, replacing the previous behaviour.
   *
   * This used to strip the issuer proof, tag the result `DerivedCredential` and
   * emit it. Privacy was honoured — withheld claims genuinely did not leave —
   * but the artefact was a credential-shaped object no verifier could verify,
   * because a conventional JSON-LD proof signs the whole document and removing
   * a claim breaks it.
   *
   * Two things were wrong with shipping that:
   *
   *   1. It over-promised to the USER. They consented to sharing two claims,
   *      believed they had shared verified data, and the verifier rejected it
   *      after the fact. The failure landed after consent, where they could no
   *      longer make a different choice.
   *   2. It taught VERIFIERS that proof-less credentials are a normal thing to
   *      receive. A lax one would accept forged claims.
   *
   * Refusing fails loudly at consent time instead, which is the only moment the
   * user can still decide. The cost is real and should not be glossed: a user
   * who wants to stay verifiable on this format must now disclose everything,
   * and pushing people toward full disclosure is a privacy regression we are
   * causing. That cost is the reason this is a stopgap.
   *
   * The actual fix is a FORMAT change, not a disclosure-logic change. SD-JWT has
   * cryptographic selective disclosure — the issuer signs per-claim commitments,
   * the holder reveals a subset, and the issuer's signature still verifies.
   * `src/services/sdjwt.ts` already parses disclosures and builds presentations,
   * and the messaging profile already lists `dc+sd-jwt`. Issuing
   * selectively-disclosable credentials in that format removes this choice
   * entirely. Tracked for Phase 2.
   */
  return { ok: false, reason: 'partial-disclosure-unsupported', withheld }
}
