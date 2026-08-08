/**
 * Story 1.13 Phase 3 — the tab-response transport.
 *
 * Every extracted handler core returns DATA; something has to put that data on
 * the wire back to the originating page. That "something" used to be a dozen
 * closures inside `defineBackground`, which is why the entrypoint could never
 * shrink to a composition root. They live here now.
 *
 * These functions are the ONLY writers of the background → content-script
 * response envelope. Their `type` strings and payload field names are a
 * CONTRACT with `entrypoints/credential-api.content.ts`, which translates each
 * one into the `ATTESTTO_*_RESPONSE` the page listens for. `tab-responses.spec.ts`
 * pins that contract by running the real bridge, not by restating these literals.
 *
 * `tabId === null` means the originating tab is gone (or the caller was an
 * extension page, which has no tab). There is nowhere to deliver, so the send is
 * dropped — loudly for the request/response flows where the caller is waiting.
 */
import type { KeyBackupShares } from '@/background/handlers/key-backup.handler'
import type { WalletAuthResponse } from '@/services/did-auth'

/**
 * Fire-and-forget message to a page tab's content script.
 *
 * The tab may have closed or navigated between when its id was captured and
 * now — `chrome.tabs.sendMessage` then rejects with "No tab with id: N", an
 * expected race, not a failure. Swallow it so it doesn't surface as an
 * "Unchecked runtime.lastError" in the service-worker console. Callers here
 * never read the response (the page receives it via the content-script bridge).
 */
export function notifyTab(tabId: number, message: unknown): void {
  void chrome.tabs.sendMessage(tabId, message).catch(() => {})
}

/** Drop with a warning when there is no tab to answer. Returns false if dropped. */
function deliverable(tabId: number | null, wireType: string, requestId: string): tabId is number {
  if (!tabId) {
    console.warn(`[Attestto ID] Dropping ${wireType} — no originating tabId`, { requestId })
    return false
  }
  return true
}

// ── Document signing (SIGN_DOCUMENT_*) ───────────────────────────

export function sendSigningErrorToTab(tabId: number | null, requestId: string, error: string): void {
  if (tabId) {
    notifyTab(tabId, { type: 'SIGN_DOCUMENT_RESPONSE', payload: { requestId, error } })
  }
}

export function sendSigningResponseToTab(
  tabId: number | null,
  requestId: string,
  data: { did: string; signature: string; publicKeyJwk: Record<string, string>; timestamp: string },
): void {
  if (tabId) {
    notifyTab(tabId, { type: 'SIGN_DOCUMENT_RESPONSE', payload: { requestId, ...data } })
  }
}

// ── DID authentication (AUTH_*) ──────────────────────────────────

export function sendAuthErrorToTab(tabId: number | null, requestId: string, error: string): void {
  if (tabId) {
    notifyTab(tabId, { type: 'AUTH_RESPONSE', payload: { requestId, error } })
  }
}

export function sendAuthResponseToTab(
  tabId: number | null,
  requestId: string,
  data: { did: string; signature: string; nonce: string; timestamp: string; publicKeyJwk: Record<string, string> },
): void {
  if (tabId) {
    notifyTab(tabId, { type: 'AUTH_RESPONSE', payload: { requestId, ...data } })
  }
}

// ── credential-wallet:auth response bridge (SOC-71) ──────────────
// These route back through the ISOLATED content script, which posts
// ATTESTTO_CW_AUTH_RESPONSE to the page; the MAIN world then dispatches the
// `credential-wallet:auth-response` event `verifyAuth` listens for. `requestId`
// is the envelope nonce the site used to correlate request → response.

export function sendCwAuthErrorToTab(tabId: number | null, requestId: string, error: string): void {
  if (tabId) {
    notifyTab(tabId, { type: 'CW_AUTH_RESPONSE', payload: { requestId, error } })
  }
}

export function sendCwAuthResponseToTab(
  tabId: number | null,
  requestId: string,
  response: WalletAuthResponse,
): void {
  if (tabId) {
    notifyTab(tabId, { type: 'CW_AUTH_RESPONSE', payload: { requestId, response } })
  }
}

// ── Attestto self-attested PDF signing (ATT-364) ─────────────────

export function sendAttesttoPdfErrorToTab(tabId: number | null, requestId: string, error: string): void {
  if (tabId) {
    notifyTab(tabId, { type: 'SIGN_ATTESTTO_PDF_RESPONSE', payload: { requestId, error } })
  }
}

export function sendAttesttoPdfResponseToTab(
  tabId: number | null,
  requestId: string,
  data: { did: string; signature: string; publicKey: string },
): void {
  if (tabId) {
    notifyTab(tabId, { type: 'SIGN_ATTESTTO_PDF_RESPONSE', payload: { requestId, ...data } })
  }
}

// ── Payment (PAYMENT_*) ──────────────────────────────────────────

export function sendPaymentErrorToTab(tabId: number | null, requestId: string, error: string): void {
  if (tabId) {
    notifyTab(tabId, { type: 'PAYMENT_RESPONSE', payload: { requestId, error } })
  }
}

export function sendPaymentResponseToTab(
  tabId: number | null,
  requestId: string,
  data: { did: string; signature: string; publicKeyJwk: Record<string, string> },
): void {
  if (tabId) {
    notifyTab(tabId, { type: 'PAYMENT_RESPONSE', payload: { requestId, ...data } })
  }
}

// ── CHAPI / Credential API (CREDENTIAL_API_RESPONSE) ─────────────

export function sendChapiErrorToTab(tabId: number | null, requestId: string, error: string): void {
  if (!deliverable(tabId, 'CHAPI error', requestId)) return
  notifyTab(tabId, { type: 'CREDENTIAL_API_RESPONSE', payload: { requestId, error } })
}

// ── DID sync (DID_SYNC_RESPONSE) ─────────────────────────────────

export function sendDidSyncResponse(
  tabId: number | null,
  requestId: string,
  publicKeyJwk: JsonWebKey | null,
  holderDid: string | null,
  error: string | null,
): void {
  if (!deliverable(tabId, 'DID_SYNC_RESPONSE', requestId)) return
  notifyTab(tabId, {
    type: 'DID_SYNC_RESPONSE',
    payload: { requestId, publicKeyJwk, holderDid, error },
  })
}

// ── Key administration (Options-UI-only) ─────────────────────────
// NOTE: an extension page carries no `sender.tab`, so `tabId` is null for every
// real caller of these three and the send is always dropped. The content script
// deliberately has no bridge for them either (SOC-2/3/8). They are kept at
// parity with the pre-extraction behaviour; see SOC ticket on the dead
// KEY_ROTATE / KEY_BACKUP / KEY_RESTORE surface.

export function sendKeyRotateResponse(
  tabId: number | null,
  requestId: string,
  newPublicKeyJwk: JsonWebKey | null,
  oldPublicKeyJwk: JsonWebKey | null,
  error: string | null,
): void {
  if (!deliverable(tabId, 'KEY_ROTATE_RESPONSE', requestId)) return
  notifyTab(tabId, {
    type: 'KEY_ROTATE_RESPONSE',
    payload: { requestId, newPublicKeyJwk, oldPublicKeyJwk, error },
  })
}

export function sendKeyBackupResponse(
  tabId: number | null,
  requestId: string,
  shares: KeyBackupShares | null,
  error: string | null,
): void {
  if (!deliverable(tabId, 'KEY_BACKUP_RESPONSE', requestId)) return
  notifyTab(tabId, { type: 'KEY_BACKUP_RESPONSE', payload: { requestId, shares, error } })
}

export function sendKeyRestoreResponse(
  tabId: number | null,
  requestId: string,
  error: string | null,
): void {
  if (!deliverable(tabId, 'KEY_RESTORE_RESPONSE', requestId)) return
  notifyTab(tabId, {
    type: 'KEY_RESTORE_RESPONSE',
    payload: { requestId, success: error === null, error },
  })
}

// ── Re-share of a stored VP (RESHARE_STORED_VP_RESPONSE) ─────────

export function sendReshareError(tabId: number | null, requestId: string, error: string): void {
  if (!deliverable(tabId, 'RESHARE_STORED_VP_RESPONSE error', requestId)) return
  notifyTab(tabId, { type: 'RESHARE_STORED_VP_RESPONSE', payload: { requestId, error } })
}
