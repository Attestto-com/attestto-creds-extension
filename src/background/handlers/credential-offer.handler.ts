/**
 * The credential-offer intake decision.
 *
 * There is exactly one outcome: the user is asked. Every offer, every format,
 * every origin, every time.
 *
 * ── What was here before, and why it is gone (Eduardo, 2026-08-14) ─────────
 *
 * This used to skip consent when the offer was `attestto-id` AND the origin had
 * been approved once before, on the reasoning that silent acceptance was a UX
 * feature for recurring identity sync. It was written as a hardening of an older
 * hole (auto-accepting ANY `attestto-id` from ANY origin), so it read as the
 * safe version of a bad idea rather than as the bad idea itself.
 *
 * The rule it violated: a page is untrusted by default and may only present
 * itself. A trusted origin may ASK — and the ask goes to the USER, who accepts
 * every time. There is no setting that passes data to a site automatically and
 * there must not be one, in either direction. Approving an origin once is not
 * standing consent for everything it sends afterwards.
 *
 * So the branch is deleted rather than narrowed. `isOriginTrusted` no longer
 * takes part in this decision at all — origin trust still gates DID_SYNC, which
 * is authorization for a channel, not consent for a payload.
 *
 * Staging order is load-bearing: the pending row must exist before the window
 * opens, because the approval window looks the offer up by id.
 */
import type { CredentialOfferMessage } from '@/utils/messaging'

type Offer = CredentialOfferMessage['payload']

/** The only outcome. Kept as a tagged object so callers read as intent, not boolean. */
export type CredentialOfferOutcome = { kind: 'pendingConsent'; notifId: string }

export interface CredentialOfferCtx {
  /**
   * Put the offer in the pending store under `notifId`. Must be AWAITED before
   * the window opens: the row lives in `storage.session` and the window's
   * cleanup can take it.
   */
  stage(notifId: string, offer: Offer, origin: string | null): Promise<void>
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
  await ctx.stage(notifId, offer, origin)
  // No branch. There is nothing to decide: the user decides.
  await ctx.requestConsent(notifId, offer, origin)
  return { kind: 'pendingConsent', notifId }
}
