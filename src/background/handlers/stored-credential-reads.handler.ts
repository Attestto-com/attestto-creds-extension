/**
 * Story 1.13 Phase 8 — the two read paths that project stored credentials out
 * to a web page.
 *
 * Both are DISCLOSURE BOUNDARIES, which is why they are pure functions with the
 * projection stated once rather than object literals built inline in a message
 * case. What a page learns about the user's wallet is decided here:
 *
 *  - `summarizeStoredCredentials` answers "what do you hold?" with metadata and
 *    the NAMES of the claim keys. Never a claim value. A site learns that a
 *    credential has a `cedula` field; it does not learn the cédula.
 *  - `buildResharePresentation` answers "share these fields" with exactly the
 *    fields named, intersected with the fields the credential actually has.
 *    Anything unselected must not appear anywhere in the result.
 *
 * The specs assert those invariants against the SERIALIZED result, not against
 * a list of expected keys — a projection that leaks by nesting an extra object
 * passes a key-list check and fails a substring check on the payload.
 */
import type { VaultData } from '@/stores/wallet'
import type { StoredCredential, CredentialFormat } from '@/types/credential'

/** What a page is told about one stored credential. Metadata plus claim key NAMES. */
export interface StoredCredentialSummary {
  id: string
  format: CredentialFormat
  issuer: string
  issuedAt: string
  expiresAt: string | null
  types: string[]
  /** Key names only — the values stay in the vault. */
  claimKeys: string[]
  source: string
}

/**
 * Project the vault's credentials to summaries.
 *
 * A locked vault (`null`) yields an empty list rather than an error: "I hold
 * nothing you can see" is the honest answer to an unauthenticated page, and it
 * does not leak whether the wallet is locked or empty.
 */
export function summarizeStoredCredentials(vault: VaultData | null): StoredCredentialSummary[] {
  return (vault?.credentials ?? []).map((c: StoredCredential) => ({
    id: c.id,
    format: c.format,
    issuer: c.issuer,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    types: c.types,
    claimKeys: Object.keys(c.decodedClaims ?? {}),
    source: c.metadata.source,
  }))
}

/** The presentation handed back for a re-share. Carries only the selected claims. */
export interface ResharePresentation {
  credentialId: string
  format: CredentialFormat
  issuer: string
  selectedFields: string[]
  claims: Record<string, unknown>
  issuedAt: string
  expiresAt: string | null
}

export type ReshareResult =
  | { ok: true; presentation: ResharePresentation }
  | { ok: false; error: string }

export interface ReshareRequest {
  credentialId: string
  selectedFields: string[]
}

/**
 * Build a re-share presentation for one stored credential.
 *
 * `claims` is built by intersecting the requested fields with the claims the
 * credential actually carries — an allowlist, so a field the caller invents
 * yields nothing rather than `undefined`, and no unselected claim can ride
 * along.
 *
 * The membership test is `hasOwnProperty`, not `in`, and the accumulator has a
 * null prototype. The pre-extraction code used `field in decodedClaims` on a
 * plain object literal, which meant a caller selecting `constructor` or
 * `toString` got `Object.prototype` members copied in, and one selecting
 * `__proto__` reassigned the outgoing object's prototype instead of adding a
 * key. Neither leaked user data (`JSON.stringify` drops functions), but the
 * selection allowlist has to be an own-property check to be an allowlist at all.
 */
export function buildResharePresentation(
  vault: VaultData | null,
  request: ReshareRequest,
): ReshareResult {
  if (!vault) return { ok: false, error: 'Vault locked' }

  const credential = (vault.credentials ?? []).find(
    (c: StoredCredential) => c.id === request.credentialId,
  )
  if (!credential) return { ok: false, error: 'Credential not found' }

  const claims: Record<string, unknown> = Object.create(null)
  const available = credential.decodedClaims ?? {}
  for (const field of request.selectedFields) {
    if (Object.prototype.hasOwnProperty.call(available, field)) {
      Object.defineProperty(claims, field, {
        value: available[field],
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }

  return {
    ok: true,
    presentation: {
      credentialId: credential.id,
      format: credential.format,
      issuer: credential.issuer,
      selectedFields: request.selectedFields,
      claims,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    },
  }
}
