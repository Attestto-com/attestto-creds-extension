/**
 * Story 2.4 — request → consent → presentation, composed.
 *
 * This module owns NO consent machinery of its own. It composes the Story
 * 1.15/1.16 `PendingFlow`, whose atomic claim, tombstone-on-consume and
 * distinct missing/alreadyConsumed reasons were built and mutation-proven then.
 *
 * That is deliberate. Story 1.16 collapsed five hand-rolled copies of "look up,
 * bail if missing, then act" into one chokepoint precisely because five copies
 * meant five chances for one to drift into acting first. Writing a sixth here —
 * for the flow that POSTS CREDENTIAL MATERIAL, the highest-consequence one —
 * would be the worst place to reintroduce it.
 *
 * ── The effect is an argument, not a follow-up call ────────────────────────
 *
 * `pending.approve(id, effect)` runs `effect` only if the claim succeeded.
 * There is no ordering for this module to get wrong and no path that reaches
 * the POST without the guard having passed.
 *
 * ── What is still missing, stated plainly ──────────────────────────────────
 *
 * The verifier is NOT authenticated. `verified: false` rides on the stored row
 * so the consent screen must render the client_id as a CLAIM. Proving it needs
 * a signed request object checked against the client's DID document — the
 * Story 2.1 resolver is there for it, and it is the next slice, not this one.
 * Until then this flow is honest about what it knows rather than presenting a
 * well-formed request as a trusted one.
 */
import { parseAuthorizationRequest, type AuthorizationRequest } from './oid4vp-request'
import { buildPresentationResponse } from './oid4vp-presentation'
import type { PendingFlow } from '@/background/consent/pending-flow'
import type { JwsSigner } from '@/services/jws'

/** What is stashed between the request arriving and the user deciding. */
export interface Oid4vpPendingRow {
  request: AuthorizationRequest
}

export interface DirectPoster {
  post(
    responseUri: string,
    body: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; status: number }>
}

export interface Oid4vpFlowDeps {
  pending: PendingFlow<Oid4vpPendingRow>
  directPost: DirectPoster
  sign: JwsSigner
  holderDid: string
  loadCredential: () => Promise<Record<string, unknown>>
}

export type ReceiveResult =
  | { ok: true; value: AuthorizationRequest }
  | { ok: false; reason: string }

export type ApproveResult =
  | { ok: true; status: number }
  | { ok: false; reason: string }

export function createOid4vpFlow(deps: Oid4vpFlowDeps) {
  return {
    /**
     * Parse an inbound request and, only if it is well-formed and bound, stash
     * it for consent. A request that fails parsing NEVER becomes pending —
     * there must be nothing for a later approve to find.
     */
    async receive(id: string, raw: unknown): Promise<ReceiveResult> {
      const parsed = parseAuthorizationRequest(raw)
      if (!parsed.ok) return { ok: false, reason: parsed.reason }

      await deps.pending.put(id, { request: parsed.value })
      return { ok: true, value: parsed.value }
    },

    /** Read without consuming — answers the consent screen's initial load. */
    async peek(id: string | undefined): Promise<AuthorizationRequest | null> {
      const row = await deps.pending.peek(id)
      return row?.request ?? null
    },

    /**
     * The chokepoint. Claims the row atomically and, only then, builds and
     * posts the presentation.
     *
     * A build failure still consumes the row. That is intentional: the user has
     * made their decision, and leaving the row live would let a retry present
     * against a request the user already answered. The failure is reported;
     * recovering means the verifier sends a new request.
     */
    async approve(id: string | undefined, approvedClaims: readonly string[]): Promise<ApproveResult> {
      const outcome = await deps.pending.approve(id, async (row) => {
        const credential = await deps.loadCredential()
        const built = await buildPresentationResponse({
          request: row.request,
          approvedClaims,
          credential,
          holderDid: deps.holderDid,
          sign: deps.sign,
        })
        if (!built.ok) return { ok: false as const, reason: built.reason }

        const posted = await deps.directPost.post(
          row.request.responseUri,
          built.value as unknown as Record<string, unknown>,
        )
        if (!posted.ok) return { ok: false as const, reason: 'verifier-rejected' }
        return { ok: true as const, status: posted.status }
      })

      if (!outcome.ok) return { ok: false, reason: outcome.reason }
      return outcome.value
    },

    /**
     * Refuse. Consumes the row so the request cannot later be approved.
     *
     * Returns false when there was nothing to deny — including the case where
     * it was ALREADY approved. A deny cannot un-send a presentation, and
     * reporting `true` there would tell the user their refusal took effect when
     * the credential had already left.
     */
    async deny(id: string | undefined): Promise<boolean> {
      return (await deps.pending.take(id)) !== null
    },
  }
}
