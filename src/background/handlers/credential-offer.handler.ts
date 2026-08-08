/**
 * Story 1.13 Phase 9 — the credential-offer intake decision.
 *
 * This is the gate that decides whether a credential lands in the wallet WITHOUT
 * the user seeing anything. Both conditions must hold to skip consent:
 *
 *   1. the offer is `attestto-id` — the recurring identity-sync format, the only
 *      one for which silent acceptance is a UX feature rather than a hole; and
 *   2. the origin is already trusted, i.e. the user approved a previous offer
 *      from it through the approval window.
 *
 * Anything else goes to the approval window. Historically the hole this closes
 * was auto-accepting ANY `attestto-id` payload from ANY origin, which let a page
 * push a `didUri` into `linkedIdentities[]` with no user gesture (see the repo
 * CLAUDE.md).
 *
 * The origin passed in must come from the unspoofable `sender`, never from the
 * message payload — the caller is responsible for that, and it is the reason
 * this function takes `origin` as an argument rather than reading it off the
 * offer.
 *
 * Staging order is load-bearing: the pending row must exist before either branch
 * runs, because both `accept` and `requestConsent` look the offer up by id.
 */
import type { CredentialOfferMessage } from '@/utils/messaging'

type Offer = CredentialOfferMessage['payload']

/** The identity-sync format — the only one eligible for silent acceptance. */
export const SILENT_SYNC_FORMAT = 'attestto-id'

export type CredentialOfferOutcome =
  | { kind: 'autoAccepted'; credentialId: string | null }
  | { kind: 'pendingConsent'; notifId: string }

export interface CredentialOfferCtx {
  /** Has the user previously approved this origin for silent identity sync? */
  isOriginTrusted(origin: string | null): Promise<boolean>
  /** Put the offer in the pending map under `notifId`. Must happen before either branch. */
  stage(notifId: string, offer: Offer, origin: string | null): void
  /** Accept a staged offer, returning the new credential id (or null on failure). */
  accept(notifId: string): Promise<string | null>
  /** Open the approval window for a staged offer. */
  requestConsent(notifId: string, offer: Offer, origin: string | null): Promise<void>
  /** Pending-map key. Injected so the decision is deterministic under test. */
  newNotifId(): string
}

export async function handleCredentialOffer(
  offer: Offer,
  origin: string | null,
  ctx: CredentialOfferCtx,
): Promise<CredentialOfferOutcome> {
  const notifId = ctx.newNotifId()
  ctx.stage(notifId, offer, origin)

  // A non-identity offer (sd-jwt, json-ld) is a one-off issuance event. It never
  // auto-accepts, no matter how trusted the origin is — trust was granted for
  // recurring identity sync, not for silently accepting arbitrary credentials.
  if (offer.format !== SILENT_SYNC_FORMAT) {
    await ctx.requestConsent(notifId, offer, origin)
    return { kind: 'pendingConsent', notifId }
  }

  if (await ctx.isOriginTrusted(origin)) {
    return { kind: 'autoAccepted', credentialId: await ctx.accept(notifId) }
  }

  await ctx.requestConsent(notifId, offer, origin)
  return { kind: 'pendingConsent', notifId }
}
