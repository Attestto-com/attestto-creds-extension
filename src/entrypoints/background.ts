/**
 * MV3 Service Worker — the extension's "brain".
 *
 * Responsibilities:
 * 1. Bootstrap the offscreen document for WebSocket notifications
 * 2. Handle crypto signing requests from content scripts / popup
 * 3. Handle credential offers pushed via WebSocket
 * 4. React to session expiry messages
 * 5. Keep the offscreen document alive via alarms
 */

import { MESSAGE_ROUTES } from '@/background/router/routes'
import type { KeyAdminCtx } from '@/background/ctx/ctx-bundles'
import type { DidSyncResponseData } from '@/background/handlers/did-sync.handler'
import { handleSignDocumentApprove } from '@/background/handlers/sign-document-approve.handler'
import { handlePaymentApprove } from '@/background/handlers/payment-approve.handler'
import { handleChapiApprove } from '@/background/handlers/chapi-approve.handler'
import { handleSignAttesttoPdfApprove } from '@/background/handlers/sign-attestto-pdf-approve.handler'
import { handleAuthApprove } from '@/background/handlers/auth-approve.handler'
import { createBuildBundle } from '@/background/ctx/build-bundle'
import { createSigningAdapters } from '@/background/adapters/signing-adapters'
import { createKeyAdminAdapters, createUntrustedAdapters } from '@/background/adapters/chrome-adapters'
import { handleKeyRotate } from '@/background/handlers/key-rotate.handler'
import { handleKeyBackup } from '@/background/handlers/key-backup.handler'
import { handleKeyRestore } from '@/background/handlers/key-restore.handler'
import { readVault, writeVault, readPublicVault, writePublicVault, syncPublicVault } from '@/utils/vault'
import type { VaultData } from '@/stores/wallet'
import type { CredentialOfferMessage, PushPresentationMessage, ProofAccessRequestMessage, CredentialApiRequestMessage, DIDCommInboundMessage, DidSyncMessage, KeyRestoreMessage, PaymentRequestMessage, SignDocumentRequestMessage, SignAttesttoPdfRequestMessage } from '@/utils/messaging'
import { isOriginTrusted, recordTrustedOrigin } from '@/utils/trusted-origins'
import { isExtensionSender, getSenderOrigin } from '@/utils/message-guard'
import { isPlatformOrigin } from '@/utils/platform-origins'
import { findOrCreateSiteDid, publicJwkOf } from '@/utils/site-did'
import { pinSite } from '@/utils/pin-store'
import { initToolbarStateTracker } from '@/utils/tab-state'
import { fetchCertScan, submitThreatReport } from '@/api/backend-client'
// Story 1.13 Phase 3 — the background → page response envelope is written in
// ONE place now (`background/transport/tab-responses.ts`), pinned to the content
// script's bridge by a round-trip spec. The entrypoint only transports.
import {
  sendSigningErrorToTab,
  sendSigningResponseToTab,
  sendAuthErrorToTab,
  sendAuthResponseToTab,
  sendCwAuthErrorToTab,
  sendCwAuthResponseToTab,
  sendAttesttoPdfErrorToTab,
  sendAttesttoPdfResponseToTab,
  sendPaymentErrorToTab,
  sendPaymentResponseToTab,
  sendChapiErrorToTab,
  sendChapiPresentation,
  sendStoredCredentials,
  sendResharePresentation,
  sendDidSyncResponse,
  sendReshareError,
} from '@/background/transport/tab-responses'
import { createApprovalWindows, chromeApprovalWindowPlatform } from '@/background/consent/approval-window'
import { createPendingConsent } from '@/background/consent/pending-consent'
import { createPendingFlow, approveRejection } from '@/background/consent/pending-flow'
import { createPendingStore, chromePendingStorage } from '@/background/consent/pending-store'
import { handleCredentialOfferAccept } from '@/background/handlers/credential-offer-accept.handler'
import { summarizeStoredCredentials, buildResharePresentation } from '@/background/handlers/stored-credential-reads.handler'
import { handleCredentialOffer } from '@/background/handlers/credential-offer.handler'
import { recordProofAccessRequest, recordPreparedPresentation, linkWalletAddress } from '@/background/handlers/vault-records.handler'
import { approvalParams } from '@/utils/approval-params'
import {
  createIdleLock,
  chromeAlarms,
  chromeSessionLock,
  chromeActivityStamp,
} from '@/background/lock/idle-lock'
import { shouldCountAsActivity } from '@/background/lock/user-gestures'
import { readSettings, onSettingsChanged } from '@/utils/settings-config'
import { STORAGE_KEYS } from '@/config/app'

export default defineBackground(() => {
  // ── Toolbar trust state (ATT-727) ──────────────────
  // Wires per-tab icon tinting + badge + RED-state notifications. Reads from
  // pin-store today; ATT-630 (Trust Registry) and ATT-705 (cert verifier) add
  // more signals later without touching this call site.
  initToolbarStateTracker()

  // ── Offscreen Document Management ──────────────────

  const OFFSCREEN_PATH = 'offscreen.html'

  async function ensureOffscreenDocument(): Promise<void> {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    })

    if (existingContexts.length > 0) return

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS' as chrome.offscreen.Reason],
        justification: 'Maintain WebSocket connection for real-time wallet notifications',
      })
    } catch (err) {
      // Race: another caller created the document between our check and create.
      // The exact error is "Only a single offscreen document may be created." — safe to ignore.
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('Only a single offscreen document')) throw err
    }
  }

  // ── Approval windows ───────────────────────────────
  // Opening a consent popup, positioning it, and cleaning up after a dismissed
  // one live in `background/consent/approval-window.ts` (Story 1.13 Phase 4).
  // Six flows shared one algorithm in six copies; the cleanup half — turning a
  // closed window into an explicit denial so the page never hangs — is the part
  // that had to stop being duplicated.
  const approvalWindows = createApprovalWindows(chromeApprovalWindowPlatform())

  // ── Vault-record writers (Story 1.13 Phase 10) ─────────────────
  // Proof-access requests, prepared presentations and the Solana link all append
  // to the encrypted vault and MUST mirror to the public one (the dual-vault
  // rule in CLAUDE.md). The write+mirror pair is applied inside the handler, so
  // no call site can do one without the other.
  const vaultRecordStore = {
    read: () => readVault(),
    write: (v: VaultData) => writeVault(v),
    syncPublic: (v: VaultData) => syncPublicVault(v),
  }
  const vaultRecordCtx = {
    store: vaultRecordStore,
    clock: { nowIso: () => new Date().toISOString() },
    newId: (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }

  /**
   * Open the dedicated approval window for a credential offer (identity sync OR VC issuance).
   * Notification-style: the page sent CREDENTIAL_PUSH and already got
   * `pendingConsent: true`, so there is no promise to reject — cleanup only purges.
   */
  async function openCredentialOfferApprovalWindow(
    notifId: string,
    offer: CredentialOfferMessage['payload'],
    origin: string | null,
  ): Promise<void> {
    await approvalWindows.open({
      id: notifId,
      params: approvalParams.credentialOffer({
        id: notifId,
        format: offer.format,
        issuerName: offer.issuerName,
        origin,
      }),
      width: 420,
      height: 560,
      rows: pendingOffers,
      logPrefix: '[Attestto ID] credential offer:',
    })
  }

  // ── Alarms — keep offscreen alive ──────────────────

  fireAndForget(chrome.alarms.create('keepOffscreenAlive', { periodInMinutes: 4 }), 'keep-offscreen alarm')

  // ── Idle auto-lock (Story 1.14) ────────────────────
  // The deadline is measured from the last USER gesture, held in
  // `storage.session` beside the key it guards, and every decision is recomputed
  // from it inside `background/lock/idle-lock.ts`. The entrypoint only supplies
  // the ports and forwards three events: worker start, alarm, gesture.
  //
  // What this replaced: `chrome.alarms.create('autoLock', {delayInMinutes: 1})`
  // at the top level. Because MV3 revives the worker for any message, the timer
  // restarted whenever a background tab poked the credential API — a web page
  // could hold the vault open, while the user's own popup activity reset nothing.
  const idleLock = createIdleLock({
    clock: { now: () => Date.now() },
    alarms: chromeAlarms(),
    session: chromeSessionLock(STORAGE_KEYS.SESSION_KEY),
    activity: chromeActivityStamp(),
    timeoutMs: async () => (await readSettings()).autoLockMinutes * 60_000,
  })

  // Not `async`: chrome expects a void-returning listener, so a promise handed
  // back here is one nobody awaits and whose rejection has nowhere to go.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepOffscreenAlive') {
      fireAndForget(ensureOffscreenDocument(), 'offscreen bootstrap')
    }
    fireAndForget(idleLock.onAlarm(alarm.name), 'idle-lock alarm')
  })

  // Re-arm against the deadline already running. NOT a touch — see above.
  fireAndForget(idleLock.resume(), 'idle-lock resume')

  // A shorter timeout must take effect on the open session, not on the next one.
  // Driven by the storage event rather than a message so it works no matter which
  // surface changed it (the old `AUTO_LOCK_CHANGED` message had no sender at all).
  onSettingsChanged(() => {
    fireAndForget(idleLock.resume(), 'idle-lock resume')
  })

  // ── Pending consent rows (Story 1.15) ─────────────
  // These were six `Map`s inside this closure. MV3 kills the worker after ~30s
  // idle and a consent flow is defined by waiting for a human, so the row a user
  // was about to approve routinely no longer existed by the time they clicked —
  // the page got "No pending request" for an approval genuinely given. Rows now
  // live in `chrome.storage.session` via `consent/pending-store.ts`, which
  // outlives the worker and dies with the browser.
  //
  // The `unregister` hook is NOT part of these types any more: it cannot be
  // serialized, and after a restart there is no window cleanup to disarm.
  // `pending-flow.ts` keeps it worker-local, keyed by the same id.
  const pendingFlow = <T,>(flow: string) =>
    createPendingFlow<T>(
      createPendingStore({ flow, storage: chromePendingStorage(), now: () => Date.now() }),
    )

  interface PendingOffer {
    offer: CredentialOfferMessage['payload']
    origin: string | null
  }
  const pendingOffers = pendingFlow<PendingOffer>('offer')

  /** Raw CHAPI requests waiting for the popup to unlock + approve */
  interface PendingChapiRawRequest {
    apiReq: CredentialApiRequestMessage['payload']
    senderTabId: number | null
  }
  const pendingChapiRawRequests = pendingFlow<PendingChapiRawRequest>('chapi')

  /** Pending payment requests waiting for user approval in the popup */
  interface PendingPaymentRequest {
    payReq: PaymentRequestMessage['payload']
    senderTabId: number | null
  }
  const pendingPaymentRequests = pendingFlow<PendingPaymentRequest>('payment')

  /** Pending document signing requests waiting for user approval in the popup */
  interface PendingSigningRequest {
    signReq: SignDocumentRequestMessage['payload']
    senderTabId: number | null
  }
  const pendingSigningRequests = pendingFlow<PendingSigningRequest>('signing')

  /** Pending DID authentication requests (login via extension — ATT-123) */
  interface PendingAuthRequest {
    requestId: string
    nonce: string
    timestamp: string
    origin: string
    senderTabId: number | null
    /**
     * Protocol variant. Absent = the legacy `attestto:auth` proof-of-possession
     * flow verified by CORTEX's DidAuthController. 'cw' = the identity-bridge
     * `credential-wallet:auth` flow verified by `@attestto/id-wallet-adapter`'s
     * `verifyAuth` (SOC-71). The two sign DIFFERENT canonical payloads, so the
     * approve branch must know which is in flight.
     */
    protocol?: 'cw'
    /** (cw) Audience the verifier issued — signed and echoed back. */
    audience?: string
    /** (cw) Envelope nonce that correlates the site's request → response event (distinct from the signed `nonce`). */
    envelopeNonce?: string
    /** (cw) Issuer DIDs the site will accept; carried through for the consent UI. */
    trustedIssuers?: string[]
  }
  const pendingAuthRequests = pendingFlow<PendingAuthRequest>('auth')

  /** Pending Attestto self-attested PDF sign requests (ATT-364) */
  interface PendingAttesttoPdfRequest {
    req: SignAttesttoPdfRequestMessage['payload']
    senderTabId: number | null
  }
  const pendingAttesttoPdfRequests = pendingFlow<PendingAttesttoPdfRequest>('attesttoPdf')

  // ── Pending-consent registries (Story 1.13 Phase 7) ────────────
  // `*_GET_PENDING` and `*_DENY` were ten near-identical case bodies. The DENY
  // half has to disarm the approval window before purging (else the closing
  // window reports a second cancellation) and has to be idempotent — both now
  // live once, in `consent/pending-consent.ts`. Each flow supplies only its
  // not-found string and how it reports a denial to the page.
  const offerConsent = createPendingConsent({
    flow: pendingOffers,
    notFound: 'Offer not found or already handled',
    reportDenied: () => {},
  })
  const signingConsent = createPendingConsent({
    flow: pendingSigningRequests,
    notFound: 'No pending signing request found',
    reportDenied: (row) => sendSigningErrorToTab(row.senderTabId, row.signReq.requestId, 'User declined signing'),
  })
  const authConsent = createPendingConsent({
    flow: pendingAuthRequests,
    notFound: 'No pending auth request found',
    // Route the denial back on the SAME protocol the request arrived on. A cw
    // (credential-wallet:auth) request must get a CW_AUTH_RESPONSE so the
    // MAIN-world listener resolves requestAuth immediately; sending the legacy
    // AUTH_RESPONSE would leave it hanging until its 120s timeout.
    reportDenied: (row) =>
      (row.protocol === 'cw' ? sendCwAuthErrorToTab : sendAuthErrorToTab)(
        row.senderTabId,
        row.requestId,
        'User declined',
      ),
  })
  const attesttoPdfConsent = createPendingConsent({
    flow: pendingAttesttoPdfRequests,
    notFound: 'No pending Attestto PDF sign request found',
    reportDenied: (row) => sendAttesttoPdfErrorToTab(row.senderTabId, row.req.requestId, 'User declined signing'),
  })
  const paymentConsent = createPendingConsent({
    flow: pendingPaymentRequests,
    notFound: 'No pending payment request found',
    reportDenied: (row) => sendPaymentErrorToTab(row.senderTabId, row.payReq.requestId, 'User declined payment'),
  })
  const chapiConsent = createPendingConsent({
    flow: pendingChapiRawRequests,
    notFound: 'No pending request found',
    reportDenied: (row) => sendChapiErrorToTab(row.senderTabId, row.apiReq.requestId, 'User declined'),
  })

  /**
   * Open the approval popup for a document signing request.
   */
  async function handleSigningRequest(
    signReq: SignDocumentRequestMessage['payload'],
    senderTabId: number | null,
  ): Promise<void> {
    await pendingSigningRequests.put(signReq.requestId, { signReq, senderTabId })
    await approvalWindows.open({
      id: signReq.requestId,
      params: approvalParams.signing({
        id: signReq.requestId,
        origin: signReq.origin,
        documentTitle: signReq.documentTitle,
        signerName: signReq.signerName,
      }),
      width: 380,
      height: 580,
      rows: pendingSigningRequests,
      logPrefix: '[Attestto Sign]',
      reportCancelled: (message) => sendSigningErrorToTab(senderTabId, signReq.requestId, message),
    })
  }

  /**
   * The composition root (Story 1.13 Phase 1b, AD-3). Constructs the real signing
   * adapters ONCE and hands `buildBundle` the injection site; every extracted signing
   * APPROVE case gets its capability-scoped ctx from `buildBundle('signing')` — a fresh
   * bundle per message whose ONE gated `crypto.sign` reads a per-request key-slot (AD-11c).
   * The three non-signing tiers are unwired here (throwing) until their routes migrate —
   * nothing calls `buildBundle('untrusted'|'consent'|'keyAdmin')` yet.
   */
  const unwiredBundle = <T,>(tier: string): T =>
    new Proxy({}, {
      get: () => () => {
        throw new Error(`buildBundle('${tier}') not wired until its routes migrate (Story 1.13, later phase)`)
      },
    }) as T
  const buildBundle = createBuildBundle({
    signing: createSigningAdapters({
      readVault,
      writeVault,
      syncPublicVault,
      findOrCreateSiteDid,
      publicJwkOf,
      pinSite,
    }),
    untrusted: unwiredBundle('untrusted'),
    consent: unwiredBundle('consent'),
    keyAdmin: unwiredBundle('keyAdmin'),
  })

  // KeyAdmin's concrete surface (store + P-256 keygen) and the untrusted tier's
  // chrome surface are built in `adapters/chrome-adapters.ts` (Story 1.13
  // Phase 11). The entrypoint now holds no crypto symbol at all — `generateP256`
  // used to be a bare `crypto.subtle.generateKey` here, which is exactly what the
  // F1 capability fence forbids.
  const keyAdminAdapters = createKeyAdminAdapters({ readVault, writeVault, syncPublicVault })
  const untrustedAdapters = createUntrustedAdapters()

  // ── DID Authentication (login via extension — ATT-123) ──────────

  /**
   * Open the approval popup for a DID authentication (login) request.
   * The popup signs `attestto:auth:{origin}:{nonce}:{timestamp}:{did}` with the
   * vault's P-256 key. Backend verifies via stateless proof-of-possession at
   * POST /auth/did/verify.
   */
  async function handleAuthRequest(
    authReq: { requestId: string; nonce: string; timestamp: string; origin: string },
    senderTabId: number | null,
  ): Promise<void> {
    // Always open the approval popup — including when no identity exists yet.
    // The popup's "No DID created yet" state offers an in-popup "Create DID"
    // (createDidAndRetry -> wallet.createDid, which syncs the public vault), so
    // the user creates a Digital ID and completes sign-in in one flow. An
    // earlier fail-fast replaced that flow with a dead-end error message on the
    // page — the popup is fully actionable (Create DID / Cancel), so there is no
    // empty-list hang.
    await pendingAuthRequests.put(authReq.requestId, { ...authReq, senderTabId })
    await openAuthApprovalWindow(authReq.requestId, authReq.origin, senderTabId, sendAuthErrorToTab)
  }

  /**
   * Open the shared auth approval popup for a request already stored in
   * `pendingAuthRequests`. Used by both the legacy (`attestto:auth`) and the
   * `credential-wallet:auth` (SOC-71) flows — the only per-flow difference is
   * which error sender reports a failure/cancel back to the page.
   */
  async function openAuthApprovalWindow(
    requestId: string,
    origin: string,
    senderTabId: number | null,
    sendError: (tabId: number | null, requestId: string, error: string) => void,
  ): Promise<void> {
    // Resolve the requesting page's title so the approval popup shows the same
    // "site certificate" heading the toolbar popup does (parity with
    // CurrentSiteCard, which reads tab.title). Best-effort — the tab may be gone.
    let siteName = ''
    if (senderTabId != null) {
      try {
        const tab = await chrome.tabs.get(senderTabId)
        siteName = tab?.title?.trim() || ''
      } catch {
        // Tab closed or navigated away — fall back to the origin-only card.
      }
    }

    // Aligned with other approval modes (380 wide) after the compact-header
    // refactor — the old 420×620 was sized for the bigger hero card. Height
    // dropped to 460 to remove the empty bottom gap visible at 620.
    await approvalWindows.open({
      id: requestId,
      params: approvalParams.auth({ id: requestId, origin, siteName }),
      width: 380,
      height: 460,
      rows: pendingAuthRequests,
      logPrefix: '[Attestto ID] auth:',
      reportCancelled: (message) => sendError(senderTabId, requestId, message),
    })
  }

  /**
   * Handle a `credential-wallet:auth` request (SOC-71) — the wallet side of the
   * identity-bridge DID-login flow verified by `@attestto/id-wallet-adapter`'s
   * `verifyAuth`. Mirrors `handleAuthRequest` but records the protocol +
   * audience + envelope nonce so the approve branch signs the adapter's
   * `attestto-did-auth-v1` canonical payload (not the legacy `attestto:auth`
   * one) and returns a full `AuthResponse`.
   */
  async function handleCwAuthRequest(
    authReq: {
      requestId: string
      nonce: string
      audience: string
      origin: string
      timestamp?: string
      trustedIssuers?: string[]
    },
    senderTabId: number | null,
  ): Promise<void> {
    // No fail-fast on missing identity — open the popup so its "Create DID"
    // flow can mint one and complete the sign-in in one step (see
    // handleAuthRequest). The popup is fully actionable, so no empty-list hang.
    await pendingAuthRequests.put(authReq.requestId, {
      requestId: authReq.requestId,
      nonce: authReq.nonce,
      // The signed timestamp is minted at approval time (fresh per the verifier's
      // freshness window), so the request-time value is not used for signing.
      timestamp: authReq.timestamp ?? '',
      origin: authReq.origin,
      senderTabId,
      protocol: 'cw',
      audience: authReq.audience,
      envelopeNonce: authReq.requestId,
      trustedIssuers: authReq.trustedIssuers,
    })
    await openAuthApprovalWindow(authReq.requestId, authReq.origin, senderTabId, sendCwAuthErrorToTab)
  }

  // ── Attestto self-attested PDF signing (ATT-364) ─────────────────

  /**
   * Open the approval popup for an Attestto self-attested PDF sign request.
   */
  async function handleAttesttoPdfRequest(
    req: SignAttesttoPdfRequestMessage['payload'],
    senderTabId: number | null,
  ): Promise<void> {
    await pendingAttesttoPdfRequests.put(req.requestId, { req, senderTabId })
    await approvalWindows.open({
      id: req.requestId,
      params: approvalParams.attesttoPdf({
        id: req.requestId,
        origin: req.origin,
        fileName: req.fileName,
        documentHash: req.documentHash,
      }),
      width: 380,
      height: 580,
      rows: pendingAttesttoPdfRequests,
      logPrefix: '[Attestto Sign] PDF:',
      reportCancelled: (message) => sendAttesttoPdfErrorToTab(senderTabId, req.requestId, message),
    })
  }

  // Ed25519 provisioning (ATT-364) moved to `createSigningAdapters` (Story 1.13
  // Phase 1b) — the APDF signing key is now provisioned through the composition
  // root's `buildBundle('signing')`, not a closure here.

  /**
   * Open the approval popup for a payment request.
   */
  async function handlePaymentRequest(
    payReq: PaymentRequestMessage['payload'],
    senderTabId: number | null,
  ): Promise<void> {
    await pendingPaymentRequests.put(payReq.requestId, { payReq, senderTabId })
    await approvalWindows.open({
      id: payReq.requestId,
      params: approvalParams.payment({
        id: payReq.requestId,
        origin: payReq.origin,
        amount: payReq.amount,
        currency: payReq.currency,
        merchantName: payReq.merchantName,
      }),
      width: 380,
      height: 580,
      rows: pendingPaymentRequests,
      logPrefix: '[Attestto Pay]',
      reportCancelled: (message) => sendPaymentErrorToTab(senderTabId, payReq.requestId, message),
    })
  }

  /**
   * Accept a credential offer the user approved: decode it, store it in both
   * vaults, and record trust for a first-time identity sync.
   *
   * The decision logic (format-scoped trust-on-first-use, identity minting
   * restricted to `attestto-id`, write-nothing-on-decode-failure) lives in
   * `handlers/credential-offer-accept.handler.ts` (Story 1.13 Phase 5). Here we
   * only take the pending row and inject the real vault/origin/clock adapters.
   */
  async function acceptCredentialOffer(notificationId: string): Promise<string | null> {
    // Atomic claim (Story 1.15): the get/delete pair this replaced could be
    // interleaved with the approval window's own cleanup once rows became
    // storage-backed, and both paths would think they owned the offer.
    const pending = await pendingOffers.take(notificationId)
    if (!pending) return null

    return handleCredentialOfferAccept(
      { offer: pending.offer, origin: pending.origin },
      {
        store: {
          readPublic: readPublicVault,
          writePublic: writePublicVault,
          read: readVault,
          write: writeVault,
          syncPublic: syncPublicVault,
        },
        origins: { recordTrusted: recordTrustedOrigin },
        clock: { nowIso: () => new Date().toISOString() },
        newId: () => crypto.randomUUID(),
      },
    )
  }

  // ── Notification button handling — REMOVED (Story 1.13 Phase 6) ──
  // There was a `chrome.notifications.onButtonClicked` listener here that
  // treated EVERY button-bearing notification as a credential offer. No
  // notification in this extension is a credential offer any more: offers moved
  // to the approval window (see `openCredentialOfferApprovalWindow`), and the
  // three flows that DO raise button notifications — PROOF_ACCESS_REQUEST,
  // DIDCOMM_INBOUND, and the non-CHAPI CREDENTIAL_API_REQUEST — carry ids the
  // listener never matched. "Review" therefore did nothing and "Dismiss"
  // broadcast a spurious CREDENTIAL_REJECTED that nothing listens for.
  // Those three flows still have no notification handler; that is a product gap
  // filed separately, not something a dead listener was covering.

  // ── CHAPI Request Handler ────────────────────────────

  /**
   * Handle CHAPI request by opening a dedicated approval window.
   * Uses approval.html — a standalone entrypoint (not the toolbar popup).
   * This is the same pattern MetaMask/Phantom use for dApp approvals.
   */
  async function handleChapiRequest(
    apiReq: CredentialApiRequestMessage['payload'],
    senderTabId: number | null,
  ): Promise<void> {
    // Store the raw request + sender tab for the approval page to use
    await pendingChapiRawRequests.put(apiReq.requestId, { apiReq, senderTabId })
    await approvalWindows.open({
      id: apiReq.requestId,
      params: approvalParams.chapi({ id: apiReq.requestId, origin: apiReq.origin }),
      width: 380,
      height: 520,
      rows: pendingChapiRawRequests,
      logPrefix: '[Attestto ID] CHAPI:',
      reportCancelled: (message) => sendChapiErrorToTab(senderTabId, apiReq.requestId, message),
    })
  }

  // `completeChapiRequest` / `denyChapiRequest` — REMOVED (Story 1.13 Phase 6).
  // They read `pendingChapiRequests`, a map nothing ever wrote to, so both
  // early-returned on every call. The live CHAPI path is the approval window
  // (`handleChapiRequest` → CHAPI_APPROVE → `handleChapiApprove`).

  // ── DID Sync Handler ───────────────────────────────────

  // `handleDidSync` moved to `@/background/handlers/did-sync.handler` (Story 1.10),
  // consumed via `MESSAGE_ROUTES.DID_SYNC.handle`. The handler returns the
  // DID_SYNC_RESPONSE data; the case below transports it via `sendDidSyncResponse`.
  // `extractDidLabelForSync` was hoisted to the pure `@/utils/did-label` util.

  // Key admin (rotate / backup / restore): the handler cores live in
  // `handlers/key-*.handler.ts` (Story 1.13 Phase 2) and their transport in
  // `transport/tab-responses.ts` (Phase 3). Nothing left here.

  /** Background work with nobody waiting on it. Logged, never silent. */
  function fireAndForget(work: Promise<unknown> | void, label: string): void {
    void Promise.resolve(work).catch((err: unknown) => {
      console.error(`[Attestto ID] ${label} failed:`, err)
    })
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // ── Answering, even when the handler throws (Story 1.18) ─────
    // ESLint's `no-floating-promises` found 46 chains in this listener on its
    // FIRST EVER run, and not one of them had a `.catch`. In MV3 that is not a
    // stray console warning: `sendResponse` never fires, so the approval window
    // or the page waits for an answer that is not coming and eventually times
    // out — indistinguishable from a user who walked away. Whatever goes wrong,
    // the caller now gets a reply.
    //
    // `sendResponse` throws if called twice (or after the channel closed), and
    // a failure can race a success that already answered, so the answer is
    // latched: first reply wins, later ones are dropped rather than throwing.
    let answered = false
    const answer = (response: unknown): void => {
      if (answered) return
      answered = true
      try {
        sendResponse(response)
      } catch (err) {
        console.warn('[Attestto ID] response channel already closed', err)
      }
    }
    const answerOrFail = (work: Promise<unknown>, label: string): void => {
      void work.catch((err: unknown) => {
        console.error(`[Attestto ID] ${label} failed:`, err)
        answer({ ok: false, error: err instanceof Error ? err.message : 'Internal error' })
      })
    }

    // Story 1.14 — only a user gesture may move the idle deadline. The predicate
    // (extension sender AND an allowlisted type) lives in `lock/user-gestures`;
    // both halves are load-bearing and are proven there.
    if (shouldCountAsActivity(sender, message)) {
      fireAndForget(idleLock.touch(), 'idle-lock touch')
    }

    switch (message.type) {
      case 'NOTIFICATION_RECEIVED':
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/48.png'),
          title: 'Wallet Alert',
          message: message.payload ?? 'You have a new notification.',
        })
        sendResponse({ ok: true })
        break

      case 'SESSION_EXPIRED':
        answerOrFail(chrome.storage.session.remove('attestto_ext_session_key'), 'SESSION_EXPIRED')
        sendResponse({ ok: true })
        break

      // The touch already happened above; the case exists so the popup gets an
      // ack and so the message is a real routed type rather than a silent drop.
      case 'WALLET_ACTIVITY':
        sendResponse({ ok: true })
        break

      // ── Credential Offer Approval Window Handlers ───
      case 'CREDENTIAL_OFFER_GET_PENDING': {
        // Answers with a PROJECTION, not the row: the approval page needs only
        // what it renders, and the raw offer carries the credential itself.
        answerOrFail(offerConsent.peek(message.payload?.notifId as string | undefined).then((peeked) => {
          sendResponse(
            peeked.ok
              ? {
                  ok: true,
                  offer: { format: peeked.request.offer.format, issuerName: peeked.request.offer.issuerName },
                  origin: peeked.request.origin,
                }
              : peeked,
          )
        }), 'CREDENTIAL_OFFER_GET_PENDING')
        return true // async
      }

      case 'CREDENTIAL_OFFER_APPROVE': {
        const notifId = message.payload?.notifId as string | undefined
        if (!notifId) {
          sendResponse({ ok: false, error: 'No notifId provided' })
          break
        }
        // The disarm happens inside `acceptCredentialOffer`'s atomic take.
        answerOrFail(acceptCredentialOffer(notifId).then((credentialId) => {
          sendResponse({ ok: !!credentialId, credentialId })
        }), 'CREDENTIAL_OFFER_APPROVE')
        return true // async
      }

      case 'CREDENTIAL_OFFER_DENY': {
        answerOrFail(offerConsent.deny(message.payload?.notifId as string | undefined).then(() => sendResponse({ ok: true })), 'CREDENTIAL_OFFER_DENY')
        return true // async
      }

      case 'CREDENTIAL_OFFER': {
        const offer = message.payload as CredentialOfferMessage['payload']
        // The origin comes from the unspoofable `sender`, NEVER from the payload.
        const senderOrigin = sender?.origin ?? sender?.url ?? null

        // The silent-acceptance gate lives in `handlers/credential-offer.handler.ts`
        // (Story 1.13 Phase 9): an offer skips consent only when it is the
        // identity-sync format AND the origin was approved before.
        answerOrFail(handleCredentialOffer(offer, senderOrigin, {
          isOriginTrusted,
          stage: (notifId, staged, origin) => pendingOffers.put(notifId, { offer: staged, origin }),
          accept: acceptCredentialOffer,
          requestConsent: openCredentialOfferApprovalWindow,
          newNotifId: () => `credential-offer-${Date.now()}`,
        }).then((outcome) => {
          sendResponse(
            outcome.kind === 'autoAccepted'
              ? { ok: true, autoAccepted: true }
              : { ok: true, pendingConsent: true },
          )
        }), 'CREDENTIAL_OFFER')
        return true // async: the trust check and the window open are both awaited
      }

      case 'WALLET_LINK': {
        answerOrFail(linkWalletAddress(message.payload?.address as string | undefined, { store: vaultRecordStore }).then(
          (result) => sendResponse(result.ok ? { ok: true } : result),
        ), 'WALLET_LINK')
        return true // async
      }

      case 'PROOF_ACCESS_REQUEST': {
        const par = message.payload as ProofAccessRequestMessage['payload']
        answerOrFail(recordProofAccessRequest(par, vaultRecordCtx).then(({ record }) => {
          // Parity: the caller is told `ok` even when `stored` was false (a
          // locked vault drops the request). The handler reports the truth; this
          // line is the one that discards it. See SOC-145's sibling gap — the
          // notification below has no working handler either.
          chrome.notifications.create(record.id, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon/48.png'),
            title: 'Proof Access Request',
            message: `${par.requesterName} is requesting access to ${par.requestedFields.length} field(s).`,
            buttons: [{ title: 'Review' }, { title: 'Dismiss' }],
            requireInteraction: true,
          })
          sendResponse({ ok: true, requestId: record.id })
        }), 'PROOF_ACCESS_REQUEST')
        return true // async
      }

      case 'PUSH_PRESENTATION': {
        const push = message.payload as PushPresentationMessage['payload']
        answerOrFail(recordPreparedPresentation(push, vaultRecordCtx).then(({ record }) => {
          // The notification lives INSIDE the success path for two reasons.
          //
          // It used to sit after this call, in the listener body, reading
          // `push.selectedFields.length` with no validation — a synchronous
          // throw on any payload lacking the field, raised BEFORE `return true`
          // ran. The channel then closed with no reply and the caller waited
          // forever: precisely the hang `answerOrFail` exists to prevent, from
          // the one line that was outside it. `PUSH_PRESENTATION` crosses the
          // content-script bridge, so the payload is not ours to trust.
          //
          // And announcing "Presentation Ready" before the record is stored
          // told the user something was in their vault when the write could
          // still fail. `record` is the stored value, so the count is now the
          // one actually persisted.
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon/48.png'),
            title: 'Presentation Ready',
            message: `A prepared presentation with ${record.selectedFields?.length ?? 0} field(s) is ready in your vault.`,
          })
          sendResponse({ ok: true, preparedId: record.id })
        }), 'PUSH_PRESENTATION')
        return true // async
      }

      case 'DIDCOMM_INBOUND': {
        // Story 1.9 — extracted to the DIDCOMM_INBOUND route (parity-tested in
        // didcomm-inbound.handler.spec). Delegates DIRECTLY to `handle` (not
        // through `dispatch`, whose empty `allowFrom` would reject — the legacy
        // case did no sender-auth). Effects fire-and-forget, response stays sync —
        // same as before. The inline ctx is a thin chrome adapter; the real
        // capability-scoped bundle is built by the composition root (Story 1.13),
        // which also removes this cast.
        void MESSAGE_ROUTES.DIDCOMM_INBOUND.handle(
          (message as DIDCommInboundMessage).payload,
          untrustedAdapters as never,
        )
        sendResponse({ ok: true })
        break
      }

      case 'CREDENTIAL_API_REQUEST': {
        const apiReq = message.payload as CredentialApiRequestMessage['payload']

        if (apiReq.protocol === 'chapi') {
          // CHAPI standard — open popup for user consent (Phantom-style)
          answerOrFail(handleChapiRequest(apiReq, sender.tab?.id ?? null).then(() => {
            sendResponse({ ok: true })
          }), 'CREDENTIAL_API_REQUEST')
        } else {
          // Attestto proprietary — forward to popup consent UI
          chrome.notifications.create(`cred-api-${apiReq.requestId}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon/48.png'),
            title: 'Identity Verification',
            message: `${apiReq.origin} is requesting identity verification.`,
            buttons: [{ title: 'Review' }, { title: 'Decline' }],
            requireInteraction: true,
          })

          answerOrFail(chrome.runtime.sendMessage({
            type: 'CREDENTIAL_API_REQUEST_FORWARD',
            payload: apiReq,
          }), 'CREDENTIAL_API_REQUEST')
          sendResponse({ ok: true })
        }
        break
      }

      case 'LIST_STORED_CREDENTIALS': {
        const listReqId = message.payload?.requestId as string
        const listSenderTabId = sender.tab?.id ?? null
        answerOrFail(readVault().then((vault) => {
          sendStoredCredentials(listSenderTabId, listReqId, summarizeStoredCredentials(vault))
          sendResponse({ ok: true })
        }), 'LIST_STORED_CREDENTIALS')
        break
      }

      case 'RESHARE_STORED_VP': {
        const resharePayload = message.payload as {
          requestId: string
          credentialId: string
          selectedFields: string[]
        }
        const reshareSenderTabId = sender.tab?.id ?? null

        answerOrFail(readVault().then((vault) => {
          const result = buildResharePresentation(vault, resharePayload)
          if (!result.ok) {
            sendReshareError(reshareSenderTabId, resharePayload.requestId, result.error)
            sendResponse({ ok: false })
            return
          }
          sendResharePresentation(reshareSenderTabId, resharePayload.requestId, result.presentation)
          sendResponse({ ok: true })
        }), 'RESHARE_STORED_VP')
        break
      }

      // DID_SYNC writes holderDid / verificationMethod into the vault. It is a
      // legitimate platform→extension flow, so it is not hard-rejected — but the
      // sender origin MUST be authorized, resolved from the unspoofable `sender`
      // (never the page-supplied payload.origin). Platform origins pass silently;
      // previously user-trusted origins pass; everything else is rejected
      // (SOC-9). Trust-on-first-use approval UX for unknown origins is a
      // follow-up (no current origin needs it — the platform is allowlisted).
      case 'DID_SYNC': {
        const syncReq = message.payload as DidSyncMessage['payload']
        const senderTabId = sender.tab?.id ?? null
        const senderOrigin = getSenderOrigin(sender)

        // Inline ctx adapter over the real chrome/vault surface (the composition
        // root, Story 1.13, replaces this + the `as never` boundary cast with the
        // router's `buildBundle`). The handler returns the DID_SYNC_RESPONSE data;
        // this case owns transport (`sendDidSyncResponse`) and the runtime ack.
        const didSyncCtx: Pick<KeyAdminCtx, 'store' | 'keygen' | 'clock'> = {
          ...keyAdminAdapters,
          clock: { now: () => Date.now() },
        }

        const runSync = () =>
          MESSAGE_ROUTES.DID_SYNC.handle(syncReq, didSyncCtx as never).then((data) => {
            const r = data as DidSyncResponseData
            sendDidSyncResponse(senderTabId, r.requestId, r.publicKeyJwk, r.holderDid, r.error)
            sendResponse({ ok: true })
          })

        if (isPlatformOrigin(senderOrigin)) {
          answerOrFail(runSync(), 'DID_SYNC')
        } else {
          answerOrFail(isOriginTrusted(senderOrigin).then((trusted) => {
            if (trusted) {
              answerOrFail(runSync(), 'DID_SYNC')
            } else {
              console.warn('[Attestto ID] Rejected DID_SYNC from unauthorized origin', senderOrigin)
              sendDidSyncResponse(senderTabId, syncReq.requestId, null, null, 'origin_not_authorized')
              sendResponse({ ok: false, error: 'origin_not_authorized' })
            }
          }), 'DID_SYNC')
        }
        break
      }

      // Key-management ops (rotate / backup / restore) touch the signing key
      // itself. They are Options-UI-only: only the extension's own pages may
      // invoke them. A web page always carries sender.tab and is rejected here
      // (SOC-2 / SOC-3 / SOC-8). The page bridge no longer forwards these types,
      // so this guard is defense-in-depth for any future/internal caller.
      //
      // SOC-144 — these three answer over `sendResponse`, not `chrome.tabs`.
      //
      // They used to hand their result to `sendKey*Response(tabId, …)`, which
      // posts with `chrome.tabs.sendMessage`. The only sender permitted here is
      // an extension page, and an extension page carries no `sender.tab`, so
      // `tabId` was `null` on every real call and the transport dropped the
      // result with a console warning. The permitted caller and the answerable
      // caller were disjoint sets: a tab-based reply for an Options-UI-only
      // operation is a category error.
      //
      // The result now travels on the channel the caller is already awaiting.
      // The `return true` is for consistency with every other async case here;
      // it is not load-bearing, because the listener returns `true`
      // unconditionally at the end regardless. Only the transport was broken.
      case 'KEY_ROTATE': {
        if (!isExtensionSender(sender)) {
          console.warn('[Attestto ID] Rejected KEY_ROTATE from non-extension sender', getSenderOrigin(sender))
          sendResponse({ ok: false, error: 'forbidden_sender' })
          break
        }
        answerOrFail(handleKeyRotate(keyAdminAdapters).then((result) => {
          sendResponse(
            result.error
              ? { ok: false, error: result.error }
              : { ok: true, newPublicKeyJwk: result.newPublicKeyJwk, oldPublicKeyJwk: result.oldPublicKeyJwk },
          )
        }), 'KEY_ROTATE')
        return true // async
      }

      case 'KEY_BACKUP': {
        if (!isExtensionSender(sender)) {
          console.warn('[Attestto ID] Rejected KEY_BACKUP from non-extension sender', getSenderOrigin(sender))
          sendResponse({ ok: false, error: 'forbidden_sender' })
          break
        }
        answerOrFail(handleKeyBackup(keyAdminAdapters).then((result) => {
          sendResponse(
            result.error ? { ok: false, error: result.error } : { ok: true, shares: result.shares },
          )
        }), 'KEY_BACKUP')
        return true // async
      }

      case 'KEY_RESTORE': {
        if (!isExtensionSender(sender)) {
          console.warn('[Attestto ID] Rejected KEY_RESTORE from non-extension sender', getSenderOrigin(sender))
          sendResponse({ ok: false, error: 'forbidden_sender' })
          break
        }
        const restoreReq = message.payload as KeyRestoreMessage['payload']
        answerOrFail(handleKeyRestore({ shareA: restoreReq.shareA, shareB: restoreReq.shareB }, keyAdminAdapters).then((result) => {
          sendResponse(result.error ? { ok: false, error: result.error } : { ok: true })
        }), 'KEY_RESTORE')
        return true // async
      }

      case 'CREDENTIAL_ACCEPTED':
      case 'CREDENTIAL_REJECTED':
        // Forward to popup if open
        sendResponse({ ok: true })
        break

      // ── Document Signing Request Handler ──

      case 'SIGN_DOCUMENT_REQUEST': {
        const signReq = message.payload as SignDocumentRequestMessage['payload']
        answerOrFail(handleSigningRequest(signReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        }), 'SIGN_DOCUMENT_REQUEST')
        break
      }

      case 'SIGN_DOCUMENT_GET_PENDING':
        answerOrFail(signingConsent.peek(message.payload?.requestId as string).then(sendResponse), 'SIGN_DOCUMENT_GET_PENDING')
        return true // async

      case 'SIGN_DOCUMENT_APPROVE': {
        const signApproveId = message.payload?.requestId as string
        const selectedSignDid = message.payload?.selectedDid as string
        // Story 1.15/1.16 — `approve` claims the row, marks it consumed, disarms
        // the window, and only THEN runs this body. The body is an argument, not
        // something that runs after a check, so there is no way to reach the
        // effect without the guard having passed. A replay lands on the tombstone
        // and is rejected as already-processed.
        answerOrFail(pendingSigningRequests.approve(signApproveId, (pendingSigning) => {

          // Story 1.13 Phase 1b — the extracted signing CORE gets its ctx from the
          // composition root's `buildBundle('signing')` (AD-3): a fresh bundle whose
          // ONE gated `crypto.sign` signs with the root key (no provisioning here). The
          // inline `createGatedSign` adapter is gone. This case still owns the
          // transport (SW lifecycle state, AD-14).
          const signDocumentCtx = buildBundle('signing')

          return handleSignDocumentApprove(
            { signingToken: pendingSigning.signReq.signingToken, selectedDid: selectedSignDid },
            signDocumentCtx,
          ).then((result) => {
            if (result.ok) {
              const responseData = {
                did: result.did,
                signature: result.signature,
                timestamp: result.timestamp,
                publicKeyJwk: result.publicKeyJwk as unknown as Record<string, string>,
              }
              sendSigningResponseToTab(pendingSigning.senderTabId, pendingSigning.signReq.requestId, responseData)
              sendResponse({ ok: true, ...responseData })
            } else {
              sendSigningErrorToTab(pendingSigning.senderTabId, pendingSigning.signReq.requestId, result.error)
              sendResponse({ ok: false, error: result.error })
            }
          })
        }).then((outcome) => {
          if (!outcome.ok) sendResponse(approveRejection(outcome.reason, 'No pending signing request'))
        }), 'SIGN_DOCUMENT_APPROVE')
        return true // async
      }

      case 'SIGN_DOCUMENT_DENY':
        answerOrFail(signingConsent.deny(message.payload?.requestId as string).then(() => sendResponse({ ok: true })), 'SIGN_DOCUMENT_DENY')
        return true // async

      // ── DID Authentication Request Handler (login via extension — ATT-123) ──

      case 'AUTH_REQUEST': {
        const authReq = message.payload as { requestId: string; nonce: string; timestamp: string; origin: string }
        answerOrFail(handleAuthRequest(authReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        }), 'AUTH_REQUEST')
        return true // async sendResponse
      }

      case 'CW_AUTH_REQUEST': {
        // credential-wallet:auth (SOC-71) — verified by the adapter's verifyAuth.
        const cwAuthReq = message.payload as {
          requestId: string
          nonce: string
          audience: string
          origin: string
          timestamp?: string
          trustedIssuers?: string[]
        }
        answerOrFail(handleCwAuthRequest(cwAuthReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        }), 'CW_AUTH_REQUEST')
        return true // async sendResponse
      }

      case 'AUTH_GET_PENDING':
        answerOrFail(authConsent.peek(message.payload?.requestId as string).then(sendResponse), 'AUTH_GET_PENDING')
        return true // async

      case 'AUTH_APPROVE': {
        const authApproveId = message.payload?.requestId as string
        const selectedAuthDid = message.payload?.selectedDid as string | undefined
        answerOrFail(pendingAuthRequests.approve(authApproveId, (pendingAuthReq) => {

          const isCwAuth = pendingAuthReq.protocol === 'cw'
          const sendAuthErr = isCwAuth ? sendCwAuthErrorToTab : sendAuthErrorToTab
          // `selectedDid` is intentionally ignored — login uses a pairwise per-origin
          // DID, not the identity chooser (see handler).
          void selectedAuthDid

          // Story 1.13 Phase 1b — AUTH login core (`handleAuthApprove`, both protocols)
          // gets its ctx from `buildBundle('signing')`. The handler calls
          // `ctx.provisioning.provisionSiteDid(origin)` (find-or-create + stamp + write +
          // mirror, inside the adapter) which rebinds the bundle's key-slot to the
          // per-site key; the ONE gated `crypto.sign` then signs with it. Two writers as
          // named capabilities: `provisioning.provisionSiteDid` + `pin`.
          const authCtx = buildBundle('signing')

          return handleAuthApprove(
            {
              protocol: pendingAuthReq.protocol,
              origin: pendingAuthReq.origin,
              nonce: pendingAuthReq.nonce,
              timestamp: pendingAuthReq.timestamp,
              audience: pendingAuthReq.audience,
            },
            authCtx,
          ).then((result) => {
            if (result.ok && result.kind === 'cw') {
              sendCwAuthResponseToTab(pendingAuthReq.senderTabId, pendingAuthReq.requestId, result.response)
              sendResponse({ ok: true, response: result.response })
            } else if (result.ok) {
              const responseData = {
                did: result.did,
                signature: result.signature,
                nonce: result.nonce,
                timestamp: result.timestamp,
                publicKeyJwk: result.publicKeyJwk as unknown as Record<string, string>,
              }
              sendAuthResponseToTab(pendingAuthReq.senderTabId, pendingAuthReq.requestId, responseData)
              sendResponse({ ok: true, ...responseData })
            } else {
              sendAuthErr(pendingAuthReq.senderTabId, pendingAuthReq.requestId, result.error)
              sendResponse({ ok: false, error: result.error })
            }
          })
        }).then((outcome) => {
          if (!outcome.ok) sendResponse(approveRejection(outcome.reason, 'No pending auth request'))
        }), 'AUTH_APPROVE')
        return true // async sendResponse
      }

      case 'AUTH_DENY':
        answerOrFail(authConsent.deny(message.payload?.requestId as string).then(() => sendResponse({ ok: true })), 'AUTH_DENY')
        return true // async

      // ── Attestto self-attested PDF signing (ATT-364) ───────────────

      case 'SIGN_ATTESTTO_PDF_REQUEST': {
        const apdfReq = message.payload as SignAttesttoPdfRequestMessage['payload']
        answerOrFail(handleAttesttoPdfRequest(apdfReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        }), 'SIGN_ATTESTTO_PDF_REQUEST')
        break
      }

      case 'SIGN_ATTESTTO_PDF_GET_PENDING':
        answerOrFail(attesttoPdfConsent.peek(message.payload?.requestId as string).then(sendResponse), 'SIGN_ATTESTTO_PDF_GET_PENDING')
        return true // async

      case 'SIGN_ATTESTTO_PDF_APPROVE': {
        const apdfApproveId = message.payload?.requestId as string
        const selectedApdfDid = message.payload?.selectedDid as string
        answerOrFail(pendingAttesttoPdfRequests.approve(apdfApproveId, (pendingApdf) => {

          // Story 1.13 Phase 1b — APDF signing core (`handleSignAttesttoPdfApprove`) gets
          // its ctx from `buildBundle('signing')`. The handler calls
          // `ctx.provisioning.provisionEd25519()` (lazy mint + write + mirror, inside the
          // adapter) which rebinds the bundle's key-slot to the Ed25519 key; the ONE gated
          // `crypto.sign` signs with it. This case keeps the transport.
          const apdfCtx = buildBundle('signing')

          return handleSignAttesttoPdfApprove(
            { payloadB64: pendingApdf.req.payloadB64, selectedDid: selectedApdfDid },
            apdfCtx,
          ).then((result) => {
            if (result.ok) {
              const responseData = { did: result.did, signature: result.signature, publicKey: result.publicKey }
              sendAttesttoPdfResponseToTab(pendingApdf.senderTabId, pendingApdf.req.requestId, responseData)
              sendResponse({ ok: true, ...responseData })
            } else {
              sendAttesttoPdfErrorToTab(pendingApdf.senderTabId, pendingApdf.req.requestId, result.error)
              sendResponse({ ok: false, error: result.error })
            }
          })
        }).then((outcome) => {
          if (!outcome.ok) sendResponse(approveRejection(outcome.reason, 'No pending Attestto PDF sign request'))
        }), 'SIGN_ATTESTTO_PDF_APPROVE')
        return true // async
      }

      case 'SIGN_ATTESTTO_PDF_DENY':
        answerOrFail(attesttoPdfConsent.deny(message.payload?.requestId as string).then(() => sendResponse({ ok: true })), 'SIGN_ATTESTTO_PDF_DENY')
        return true // async

      // ── Payment Request Handler ──

      case 'PAYMENT_REQUEST': {
        const payReq = message.payload as PaymentRequestMessage['payload']
        answerOrFail(handlePaymentRequest(payReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        }), 'PAYMENT_REQUEST')
        break
      }

      // ── Payment Popup Handlers (DID-authenticated payment flow) ──

      case 'PAYMENT_GET_PENDING':
        answerOrFail(paymentConsent.peek(message.payload?.requestId as string).then(sendResponse), 'PAYMENT_GET_PENDING')
        return true // async

      case 'PAYMENT_APPROVE': {
        const payApproveId = message.payload?.requestId as string
        const selectedDid = message.payload?.selectedDid as string
        answerOrFail(pendingPaymentRequests.approve(payApproveId, (pendingPayment) => {

          // Story 1.13 Phase 1b — PAYMENT signing core (`handlePaymentApprove`), the twin
          // of SIGN_DOCUMENT: ctx from `buildBundle('signing')`, signs with the root key
          // through the ONE gated primitive. The case keeps the transport.
          const paymentCtx = buildBundle('signing')

          return handlePaymentApprove(
            {
              paymentRequestUuid: pendingPayment.payReq.paymentRequestUuid,
              amount: pendingPayment.payReq.amount,
              selectedDid,
            },
            paymentCtx as never,
          ).then((result) => {
            if (result.ok) {
              const responseData = {
                did: result.did,
                signature: result.signature,
                publicKeyJwk: result.publicKeyJwk as unknown as Record<string, string>,
              }
              sendPaymentResponseToTab(pendingPayment.senderTabId, pendingPayment.payReq.requestId, responseData)
              sendResponse({ ok: true, ...responseData })
            } else {
              sendPaymentErrorToTab(pendingPayment.senderTabId, pendingPayment.payReq.requestId, result.error)
              sendResponse({ ok: false, error: result.error })
            }
          })
        }).then((outcome) => {
          if (!outcome.ok) sendResponse(approveRejection(outcome.reason, 'No pending payment request'))
        }), 'PAYMENT_APPROVE')
        return true // async
      }

      case 'PAYMENT_DENY':
        answerOrFail(paymentConsent.deny(message.payload?.requestId as string).then(() => sendResponse({ ok: true })), 'PAYMENT_DENY')
        return true // async

      // ── CHAPI Popup Handlers (Phantom-style approval flow) ──

      case 'CHAPI_GET_PENDING':
        answerOrFail(chapiConsent.peek(message.payload?.requestId as string).then(sendResponse), 'CHAPI_GET_PENDING')
        return true // async

      case 'CHAPI_APPROVE': {
        const approveReqId = message.payload?.requestId as string
        answerOrFail(pendingChapiRawRequests.approve(approveReqId, (pending) => {

          // Story 1.13 Phase 1b — CHAPI presentation core (`handleChapiApprove`) gets its
          // ctx from `buildBundle('signing')`; it builds the VP through the ONE gated
          // primitive and returns it as DATA. This case owns the transport.
          const chapiCtx = buildBundle('signing')

          return handleChapiApprove(
            {
              challenge: pending.apiReq.challenge,
              nonce: pending.apiReq.nonce,
              domain: pending.apiReq.domain,
              origin: pending.apiReq.origin,
            },
            chapiCtx as never,
          ).then((result) => {
            if (result.ok) {
              // Send VP back to the original requesting tab (not the popup)
              sendChapiPresentation(pending.senderTabId, pending.apiReq.requestId, result.presentation)
              sendResponse({ ok: true, holderDid: result.holderDid })
            } else {
              sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, result.tabError ?? result.error)
              sendResponse({ ok: false, error: result.error })
            }
          })
        }).then((outcome) => {
          if (!outcome.ok) sendResponse(approveRejection(outcome.reason, 'No pending request'))
        }), 'CHAPI_APPROVE')
        return true // async
      }

      case 'CHAPI_DENY':
        answerOrFail(chapiConsent.deny(message.payload?.requestId as string).then(() => sendResponse({ ok: true })), 'CHAPI_DENY')
        return true // async

      // ── Backend scan + report ──────────────────────────────────────────────

      case 'CERT_SCAN_REQUEST': {
        // Only the hostname is forwarded — never path, query, or credentials.
        const { hostname } = message.payload as { hostname: string }
        fetchCertScan(hostname)
          .then((result) => sendResponse(result))
          .catch((err) => {
            sendResponse({ ok: false, host: hostname, error: err instanceof Error ? err.message : 'Scan failed' })
          })
        break
      }

      case 'SUBMIT_THREAT_REPORT': {
        const reportPayload = message.payload as Parameters<typeof submitThreatReport>[0]
        submitThreatReport(reportPayload)
          .then((result) => sendResponse(result))
          .catch((err) => {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : 'Submit failed' })
          })
        break
      }
    }

    return true
  })

  // ── Lifecycle ──────────────────────────────────────

  chrome.runtime.onStartup.addListener(() => {
    fireAndForget(ensureOffscreenDocument(), 'offscreen bootstrap')
  })

  chrome.runtime.onInstalled.addListener((details) => {
    fireAndForget(ensureOffscreenDocument(), 'offscreen bootstrap')
    // First-install landing — open the Settings tab directly so the user sees
    // the welcome / what-this-does on a real surface they can self-explore.
    // No multi-step tour (see ATT-726: bar-removal + popup-as-sole-trust-surface
    // decision; the multi-step onboarding was superseded by the wireframes).
    if (details.reason === ('install' as chrome.runtime.OnInstalledReason)) {
      fireAndForget(chrome.tabs.create({
        url: chrome.runtime.getURL('options.html'),
      }), 'first-install settings tab')
    }
  })
})
