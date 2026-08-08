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
 * There are three things one can do about that, and two of them are bad:
 *
 *   - send everything (the bug) — the user's choice is a lie
 *   - filter the subject and KEEP the proof — the worst option, because the
 *     document now carries an issuer signature that does not verify, and anyone
 *     reading it (or verifying lazily) reads it as issuer-attested
 *   - filter the subject and DROP the proof — what this does
 *
 * So a partial disclosure produces a HOLDER-ATTESTED derivation, not an
 * issuer-attested credential, and it says so: `proof` is removed and
 * `DerivedCredential` is appended to `type`. A verifier gets something it will
 * correctly refuse to treat as issuer-signed, which is the truthful outcome. The
 * UI has to tell the user this before they choose it — a silently weaker
 * credential is its own kind of lie.
 *
 * Selecting everything is NOT a derivation: the document is returned untouched,
 * proof intact. The common case keeps full issuer verifiability.
 */

/** Appended to `type` when claims were withheld. No proof accompanies it. */
export const DERIVED_TYPE = 'DerivedCredential'

export interface DerivedCredential {
  /** The VC to embed in the VP. */
  credential: Record<string, unknown>
  /** Claim names present in the source subject but not disclosed. */
  withheld: string[]
  /** True when nothing was withheld — issuer proof intact, fully verifiable. */
  complete: boolean
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
 * Copy the selected own-properties of `subject`.
 *
 * `Object.prototype.hasOwnProperty.call` over a NULL-prototype accumulator, for
 * the reason found in Story 1.13 Phase 8: a plain `field in subject` walks the
 * prototype chain, so a selection naming `constructor` or `toString` copies
 * `Object.prototype` members into the output, and `__proto__` reassigns the
 * accumulator's prototype instead of setting a key.
 */
function pickOwn(
  subject: Record<string, unknown>,
  selected: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = Object.create(null)
  for (const field of selected) {
    if (!Object.prototype.hasOwnProperty.call(subject, field)) continue
    Object.defineProperty(picked, field, {
      value: subject[field],
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return picked
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
): DerivedCredential {
  const subject = vc.credentialSubject
  // No subject to filter (a shape we do not model). Withholding nothing is the
  // truthful answer; it is NOT "disclose everything after claiming otherwise",
  // because there are no subject claims here to withhold.
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    return { credential: vc, withheld: [], complete: true }
  }

  const source = subject as Record<string, unknown>
  const keepSubjectId =
    typeof source.id === 'string' && options.holderDid !== undefined && source.id === options.holderDid

  const requested = new Set(selectedFields)
  if (keepSubjectId) requested.add('id')

  const withheld = Object.keys(source).filter((key) => !requested.has(key))
  if (withheld.length === 0) {
    // Nothing removed: the issuer's signature still covers the whole document.
    return { credential: vc, withheld: [], complete: true }
  }

  const { proof: _issuerProof, ...rest } = vc
  const existingTypes = Array.isArray(vc.type) ? (vc.type as string[]) : vc.type ? [vc.type as string] : []

  return {
    credential: {
      ...rest,
      type: existingTypes.includes(DERIVED_TYPE) ? existingTypes : [...existingTypes, DERIVED_TYPE],
      credentialSubject: pickOwn(source, [...requested]),
    },
    withheld,
    complete: false,
  }
}
