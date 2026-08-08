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
import type { CredentialOfferMessage, PushPresentationMessage, ProofAccessRequestMessage, CredentialApiRequestMessage, DIDCommInboundMessage, DidSyncMessage, KeyRotateMessage, KeyBackupMessage, KeyRestoreMessage, PaymentRequestMessage, SignDocumentRequestMessage, SignAttesttoPdfRequestMessage } from '@/utils/messaging'
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
  sendKeyRotateResponse,
  sendKeyBackupResponse,
  sendKeyRestoreResponse,
  sendReshareError,
} from '@/background/transport/tab-responses'
import { createApprovalWindows, chromeApprovalWindowPlatform } from '@/background/consent/approval-window'
import { createPendingConsent } from '@/background/consent/pending-consent'
import { handleCredentialOfferAccept } from '@/background/handlers/credential-offer-accept.handler'
import { summarizeStoredCredentials, buildResharePresentation } from '@/background/handlers/stored-credential-reads.handler'
import { handleCredentialOffer } from '@/background/handlers/credential-offer.handler'
import { recordProofAccessRequest, recordPreparedPresentation, linkWalletAddress } from '@/background/handlers/vault-records.handler'
import { approvalParams } from '@/utils/approval-params'

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

  chrome.alarms.create('keepOffscreenAlive', { periodInMinutes: 4 })

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'keepOffscreenAlive') {
      ensureOffscreenDocument()
    }
    if (alarm.name === 'autoLock') {
      // Clear session key to lock the vault
      await chrome.storage.session.remove('attestto_ext_session_key')
      console.log('[Attestto ID] Auto-lock triggered')
    }
  })

  // Auto-lock is fixed at 1 minute — no longer user-configurable (the timer
  // selector was removed from settings). Kept as a function so the
  // AUTO_LOCK_CHANGED message and initial setup share one code path.
  const AUTO_LOCK_MINUTES = 1
  async function resetAutoLockAlarm(): Promise<void> {
    chrome.alarms.create('autoLock', { delayInMinutes: AUTO_LOCK_MINUTES })
  }

  resetAutoLockAlarm()

  // ── Pending Credential Offers ─────────────────────

  interface PendingOffer {
    offer: CredentialOfferMessage['payload']
    origin: string | null
    unregister?: () => void
  }
  const pendingOffers = new Map<string, PendingOffer>()

  // ── Pending CHAPI Requests (waiting for user consent via popup) ──

  /** Raw CHAPI requests waiting for the popup to unlock + approve */
  interface PendingChapiRawRequest {
    apiReq: CredentialApiRequestMessage['payload']
    senderTabId: number | null
    unregister?: () => void
  }
  const pendingChapiRawRequests = new Map<string, PendingChapiRawRequest>()

  /** Pending payment requests waiting for user approval in the popup */
  interface PendingPaymentRequest {
    payReq: PaymentRequestMessage['payload']
    senderTabId: number | null
    unregister?: () => void
  }
  const pendingPaymentRequests = new Map<string, PendingPaymentRequest>()

  /** Pending document signing requests waiting for user approval in the popup */
  interface PendingSigningRequest {
    signReq: SignDocumentRequestMessage['payload']
    senderTabId: number | null
    unregister?: () => void
  }
  const pendingSigningRequests = new Map<string, PendingSigningRequest>()

  /** Pending DID authentication requests (login via extension — ATT-123) */
  interface PendingAuthRequest {
    requestId: string
    nonce: string
    timestamp: string
    origin: string
    senderTabId: number | null
    unregister?: () => void
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
  const pendingAuthRequests = new Map<string, PendingAuthRequest>()

  /** Pending Attestto self-attested PDF sign requests (ATT-364) */
  interface PendingAttesttoPdfRequest {
    req: SignAttesttoPdfRequestMessage['payload']
    senderTabId: number | null
    unregister?: () => void
  }
  const pendingAttesttoPdfRequests = new Map<string, PendingAttesttoPdfRequest>()

  // ── Pending-consent registries (Story 1.13 Phase 7) ────────────
  // `*_GET_PENDING` and `*_DENY` were ten near-identical case bodies. The DENY
  // half has to disarm the approval window before purging (else the closing
  // window reports a second cancellation) and has to be idempotent — both now
  // live once, in `consent/pending-consent.ts`. Each flow supplies only its
  // not-found string and how it reports a denial to the page.
  const offerConsent = createPendingConsent({
    rows: pendingOffers,
    notFound: 'Offer not found or already handled',
    reportDenied: () => {},
  })
  const signingConsent = createPendingConsent({
    rows: pendingSigningRequests,
    notFound: 'No pending signing request found',
    reportDenied: (row) => sendSigningErrorToTab(row.senderTabId, row.signReq.requestId, 'User declined signing'),
  })
  const authConsent = createPendingConsent({
    rows: pendingAuthRequests,
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
    rows: pendingAttesttoPdfRequests,
    notFound: 'No pending Attestto PDF sign request found',
    reportDenied: (row) => sendAttesttoPdfErrorToTab(row.senderTabId, row.req.requestId, 'User declined signing'),
  })
  const paymentConsent = createPendingConsent({
    rows: pendingPaymentRequests,
    notFound: 'No pending payment request found',
    reportDenied: (row) => sendPaymentErrorToTab(row.senderTabId, row.payReq.requestId, 'User declined payment'),
  })
  const chapiConsent = createPendingConsent({
    rows: pendingChapiRawRequests,
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
    pendingSigningRequests.set(signReq.requestId, { signReq, senderTabId })
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
    new Proxy({} as object, {
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
    pendingAuthRequests.set(authReq.requestId, { ...authReq, senderTabId })
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
    pendingAuthRequests.set(authReq.requestId, {
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
    pendingAttesttoPdfRequests.set(req.requestId, { req, senderTabId })
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
    pendingPaymentRequests.set(payReq.requestId, { payReq, senderTabId })
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
    const pending = pendingOffers.get(notificationId)
    if (!pending) return null
    pendingOffers.delete(notificationId)

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
    pendingChapiRawRequests.set(apiReq.requestId, { apiReq, senderTabId })
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

  // ── Message Router ─────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        chrome.storage.session.remove('attestto_ext_session_key')
        sendResponse({ ok: true })
        break

      case 'AUTO_LOCK_CHANGED':
        resetAutoLockAlarm()
        sendResponse({ ok: true })
        break

      // ── Credential Offer Approval Window Handlers ───
      case 'CREDENTIAL_OFFER_GET_PENDING': {
        // Answers with a PROJECTION, not the row: the approval page needs only
        // what it renders, and the raw offer carries the credential itself.
        const peeked = offerConsent.peek(message.payload?.notifId as string | undefined)
        sendResponse(
          peeked.ok
            ? {
                ok: true,
                offer: { format: peeked.request.offer.format, issuerName: peeked.request.offer.issuerName },
                origin: peeked.request.origin,
              }
            : peeked,
        )
        break
      }

      case 'CREDENTIAL_OFFER_APPROVE': {
        const notifId = message.payload?.notifId as string | undefined
        if (!notifId) {
          sendResponse({ ok: false, error: 'No notifId provided' })
          break
        }
        pendingOffers.get(notifId)?.unregister?.()
        acceptCredentialOffer(notifId).then((credentialId) => {
          sendResponse({ ok: !!credentialId, credentialId })
        })
        return true // async
      }

      case 'CREDENTIAL_OFFER_DENY': {
        offerConsent.deny(message.payload?.notifId as string | undefined)
        sendResponse({ ok: true })
        break
      }

      case 'CREDENTIAL_OFFER': {
        const offer = message.payload as CredentialOfferMessage['payload']
        // The origin comes from the unspoofable `sender`, NEVER from the payload.
        const senderOrigin = sender?.origin ?? sender?.url ?? null

        // The silent-acceptance gate lives in `handlers/credential-offer.handler.ts`
        // (Story 1.13 Phase 9): an offer skips consent only when it is the
        // identity-sync format AND the origin was approved before.
        handleCredentialOffer(offer, senderOrigin, {
          isOriginTrusted,
          stage: (notifId, staged, origin) => pendingOffers.set(notifId, { offer: staged, origin }),
          accept: acceptCredentialOffer,
          requestConsent: openCredentialOfferApprovalWindow,
          newNotifId: () => `credential-offer-${Date.now()}`,
        }).then((outcome) => {
          sendResponse(
            outcome.kind === 'autoAccepted'
              ? { ok: true, autoAccepted: true }
              : { ok: true, pendingConsent: true },
          )
        })
        return true // async: the trust check and the window open are both awaited
      }

      case 'WALLET_LINK': {
        linkWalletAddress(message.payload?.address as string | undefined, { store: vaultRecordStore }).then(
          (result) => sendResponse(result.ok ? { ok: true } : result),
        )
        return true // async
      }

      case 'PROOF_ACCESS_REQUEST': {
        const par = message.payload as ProofAccessRequestMessage['payload']
        recordProofAccessRequest(par, vaultRecordCtx).then(({ record }) => {
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
        })
        return true // async
      }

      case 'PUSH_PRESENTATION': {
        const push = message.payload as PushPresentationMessage['payload']
        recordPreparedPresentation(push, vaultRecordCtx).then(({ record }) => {
          sendResponse({ ok: true, preparedId: record.id })
        })
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/48.png'),
          title: 'Presentation Ready',
          message: `A prepared presentation with ${push.selectedFields.length} field(s) is ready in your vault.`,
        })
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
          handleChapiRequest(apiReq, sender.tab?.id ?? null).then(() => {
            sendResponse({ ok: true })
          })
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

          chrome.runtime.sendMessage({
            type: 'CREDENTIAL_API_REQUEST_FORWARD',
            payload: apiReq,
          })
          sendResponse({ ok: true })
        }
        break
      }

      case 'LIST_STORED_CREDENTIALS': {
        const listReqId = message.payload?.requestId as string
        const listSenderTabId = sender.tab?.id ?? null
        readVault().then((vault) => {
          sendStoredCredentials(listSenderTabId, listReqId, summarizeStoredCredentials(vault))
          sendResponse({ ok: true })
        })
        break
      }

      case 'RESHARE_STORED_VP': {
        const resharePayload = message.payload as {
          requestId: string
          credentialId: string
          selectedFields: string[]
        }
        const reshareSenderTabId = sender.tab?.id ?? null

        readVault().then((vault) => {
          const result = buildResharePresentation(vault, resharePayload)
          if (!result.ok) {
            sendReshareError(reshareSenderTabId, resharePayload.requestId, result.error)
            sendResponse({ ok: false })
            return
          }
          sendResharePresentation(reshareSenderTabId, resharePayload.requestId, result.presentation)
          sendResponse({ ok: true })
        })
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
          runSync()
        } else {
          isOriginTrusted(senderOrigin).then((trusted) => {
            if (trusted) {
              runSync()
            } else {
              console.warn('[Attestto ID] Rejected DID_SYNC from unauthorized origin', senderOrigin)
              sendDidSyncResponse(senderTabId, syncReq.requestId, null, null, 'origin_not_authorized')
              sendResponse({ ok: false, error: 'origin_not_authorized' })
            }
          })
        }
        break
      }

      // Key-management ops (rotate / backup / restore) touch the signing key
      // itself. They are Options-UI-only: only the extension's own pages may
      // invoke them. A web page always carries sender.tab and is rejected here
      // (SOC-2 / SOC-3 / SOC-8). The page bridge no longer forwards these types,
      // so this guard is defense-in-depth for any future/internal caller.
      case 'KEY_ROTATE': {
        if (!isExtensionSender(sender)) {
          console.warn('[Attestto ID] Rejected KEY_ROTATE from non-extension sender', getSenderOrigin(sender))
          sendResponse({ ok: false, error: 'forbidden_sender' })
          break
        }
        const rotateReq = message.payload as KeyRotateMessage['payload']
        const rotateTabId = sender.tab?.id ?? null
        handleKeyRotate(keyAdminAdapters).then((result) => {
          sendKeyRotateResponse(rotateTabId, rotateReq.requestId, result.newPublicKeyJwk, result.oldPublicKeyJwk, result.error)
          sendResponse({ ok: true })
        })
        break
      }

      case 'KEY_BACKUP': {
        if (!isExtensionSender(sender)) {
          console.warn('[Attestto ID] Rejected KEY_BACKUP from non-extension sender', getSenderOrigin(sender))
          sendResponse({ ok: false, error: 'forbidden_sender' })
          break
        }
        const backupReq = message.payload as KeyBackupMessage['payload']
        const backupTabId = sender.tab?.id ?? null
        handleKeyBackup(keyAdminAdapters).then((result) => {
          sendKeyBackupResponse(backupTabId, backupReq.requestId, result.shares, result.error)
          sendResponse({ ok: true })
        })
        break
      }

      case 'KEY_RESTORE': {
        if (!isExtensionSender(sender)) {
          console.warn('[Attestto ID] Rejected KEY_RESTORE from non-extension sender', getSenderOrigin(sender))
          sendResponse({ ok: false, error: 'forbidden_sender' })
          break
        }
        const restoreReq = message.payload as KeyRestoreMessage['payload']
        const restoreTabId = sender.tab?.id ?? null
        handleKeyRestore({ shareA: restoreReq.shareA, shareB: restoreReq.shareB }, keyAdminAdapters).then((result) => {
          sendKeyRestoreResponse(restoreTabId, restoreReq.requestId, result.error)
          sendResponse({ ok: true })
        })
        break
      }

      case 'CREDENTIAL_ACCEPTED':
      case 'CREDENTIAL_REJECTED':
        // Forward to popup if open
        sendResponse({ ok: true })
        break

      // ── Document Signing Request Handler ──

      case 'SIGN_DOCUMENT_REQUEST': {
        const signReq = message.payload as SignDocumentRequestMessage['payload']
        handleSigningRequest(signReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      case 'SIGN_DOCUMENT_GET_PENDING':
        sendResponse(signingConsent.peek(message.payload?.requestId as string))
        break

      case 'SIGN_DOCUMENT_APPROVE': {
        const signApproveId = message.payload?.requestId as string
        const selectedSignDid = message.payload?.selectedDid as string
        const pendingSigning = pendingSigningRequests.get(signApproveId)

        if (!pendingSigning) {
          sendResponse({ ok: false, error: 'No pending signing request' })
          break
        }
        pendingSigning.unregister?.()
        pendingSigningRequests.delete(signApproveId)

        // Story 1.13 Phase 1b — the extracted signing CORE gets its ctx from the
        // composition root's `buildBundle('signing')` (AD-3): a fresh bundle whose
        // ONE gated `crypto.sign` signs with the root key (no provisioning here). The
        // inline `createGatedSign` adapter is gone. This case still owns the pending
        // Map + transport + window-unregister (SW lifecycle state, AD-14).
        const signDocumentCtx = buildBundle('signing')

        handleSignDocumentApprove(
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
        break
      }

      case 'SIGN_DOCUMENT_DENY':
        signingConsent.deny(message.payload?.requestId as string)
        sendResponse({ ok: true })
        break

      // ── DID Authentication Request Handler (login via extension — ATT-123) ──

      case 'AUTH_REQUEST': {
        const authReq = message.payload as { requestId: string; nonce: string; timestamp: string; origin: string }
        handleAuthRequest(authReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
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
        handleCwAuthRequest(cwAuthReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
        return true // async sendResponse
      }

      case 'AUTH_GET_PENDING':
        sendResponse(authConsent.peek(message.payload?.requestId as string))
        break

      case 'AUTH_APPROVE': {
        const authApproveId = message.payload?.requestId as string
        const selectedAuthDid = message.payload?.selectedDid as string | undefined
        const pendingAuthReq = pendingAuthRequests.get(authApproveId)

        if (!pendingAuthReq) {
          sendResponse({ ok: false, error: 'No pending auth request' })
          break
        }
        pendingAuthReq.unregister?.()
        pendingAuthRequests.delete(authApproveId)

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

        handleAuthApprove(
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
        return true // async sendResponse
      }

      case 'AUTH_DENY':
        authConsent.deny(message.payload?.requestId as string)
        sendResponse({ ok: true })
        break

      // ── Attestto self-attested PDF signing (ATT-364) ───────────────

      case 'SIGN_ATTESTTO_PDF_REQUEST': {
        const apdfReq = message.payload as SignAttesttoPdfRequestMessage['payload']
        handleAttesttoPdfRequest(apdfReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      case 'SIGN_ATTESTTO_PDF_GET_PENDING':
        sendResponse(attesttoPdfConsent.peek(message.payload?.requestId as string))
        break

      case 'SIGN_ATTESTTO_PDF_APPROVE': {
        const apdfApproveId = message.payload?.requestId as string
        const selectedApdfDid = message.payload?.selectedDid as string
        const pendingApdf = pendingAttesttoPdfRequests.get(apdfApproveId)

        if (!pendingApdf) {
          sendResponse({ ok: false, error: 'No pending Attestto PDF sign request' })
          break
        }
        pendingApdf.unregister?.()
        pendingAttesttoPdfRequests.delete(apdfApproveId)

        // Story 1.13 Phase 1b — APDF signing core (`handleSignAttesttoPdfApprove`) gets
        // its ctx from `buildBundle('signing')`. The handler calls
        // `ctx.provisioning.provisionEd25519()` (lazy mint + write + mirror, inside the
        // adapter) which rebinds the bundle's key-slot to the Ed25519 key; the ONE gated
        // `crypto.sign` signs with it. This case keeps the pending Map + transport.
        const apdfCtx = buildBundle('signing')

        handleSignAttesttoPdfApprove(
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
        break
      }

      case 'SIGN_ATTESTTO_PDF_DENY':
        attesttoPdfConsent.deny(message.payload?.requestId as string)
        sendResponse({ ok: true })
        break

      // ── Payment Request Handler ──

      case 'PAYMENT_REQUEST': {
        const payReq = message.payload as PaymentRequestMessage['payload']
        handlePaymentRequest(payReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      // ── Payment Popup Handlers (DID-authenticated payment flow) ──

      case 'PAYMENT_GET_PENDING':
        sendResponse(paymentConsent.peek(message.payload?.requestId as string))
        break

      case 'PAYMENT_APPROVE': {
        const payApproveId = message.payload?.requestId as string
        const selectedDid = message.payload?.selectedDid as string
        const pendingPayment = pendingPaymentRequests.get(payApproveId)

        if (!pendingPayment) {
          sendResponse({ ok: false, error: 'No pending payment request' })
          break
        }
        pendingPayment.unregister?.()
        pendingPaymentRequests.delete(payApproveId)

        // Story 1.13 Phase 1b — PAYMENT signing core (`handlePaymentApprove`), the twin
        // of SIGN_DOCUMENT: ctx from `buildBundle('signing')`, signs with the root key
        // through the ONE gated primitive. The case keeps the pending Map + transport.
        const paymentCtx = buildBundle('signing')

        handlePaymentApprove(
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
        break
      }

      case 'PAYMENT_DENY':
        paymentConsent.deny(message.payload?.requestId as string)
        sendResponse({ ok: true })
        break

      // ── CHAPI Popup Handlers (Phantom-style approval flow) ──

      case 'CHAPI_GET_PENDING':
        sendResponse(chapiConsent.peek(message.payload?.requestId as string))
        break

      case 'CHAPI_APPROVE': {
        const approveReqId = message.payload?.requestId as string
        const pending = pendingChapiRawRequests.get(approveReqId)
        if (!pending) {
          sendResponse({ ok: false, error: 'No pending request' })
          break
        }
        pending.unregister?.()
        pendingChapiRawRequests.delete(approveReqId)

        // Story 1.13 Phase 1b — CHAPI presentation core (`handleChapiApprove`) gets its
        // ctx from `buildBundle('signing')`; it builds the VP through the ONE gated
        // primitive and returns it as DATA. This case owns the pending Map + transport.
        const chapiCtx = buildBundle('signing')

        handleChapiApprove(
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
        break
      }

      case 'CHAPI_DENY':
        chapiConsent.deny(message.payload?.requestId as string)
        sendResponse({ ok: true })
        break

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
    ensureOffscreenDocument()
  })

  chrome.runtime.onInstalled.addListener((details) => {
    ensureOffscreenDocument()
    // First-install landing — open the Settings tab directly so the user sees
    // the welcome / what-this-does on a real surface they can self-explore.
    // No multi-step tour (see ATT-726: bar-removal + popup-as-sole-trust-surface
    // decision; the multi-step onboarding was superseded by the wireframes).
    if (details.reason === 'install') {
      chrome.tabs.create({
        url: chrome.runtime.getURL('options.html'),
      })
    }
  })
})
