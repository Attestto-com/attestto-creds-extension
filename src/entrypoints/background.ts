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

import { parseSdJwt, getDecodedClaims } from '@/services/sdjwt'
import { MESSAGE_ROUTES } from '@/background/router/routes'
import type { UntrustedCtx, KeyAdminCtx } from '@/background/ctx/ctx-bundles'
import type { DidSyncResponseData } from '@/background/handlers/did-sync.handler'
import { handleSignDocumentApprove } from '@/background/handlers/sign-document-approve.handler'
import { handlePaymentApprove } from '@/background/handlers/payment-approve.handler'
import { handleChapiApprove } from '@/background/handlers/chapi-approve.handler'
import { handleSignAttesttoPdfApprove } from '@/background/handlers/sign-attestto-pdf-approve.handler'
import { handleAuthApprove } from '@/background/handlers/auth-approve.handler'
import { createGatedSign } from '@/background/crypto/gated-sign'
import { createBuildBundle } from '@/background/ctx/build-bundle'
import { createSigningAdapters, es256RawSign } from '@/background/adapters/signing-adapters'
import { handleKeyRotate } from '@/background/handlers/key-rotate.handler'
import { handleKeyBackup } from '@/background/handlers/key-backup.handler'
import { handleKeyRestore } from '@/background/handlers/key-restore.handler'
import { createChapiVp } from '@/services/jsonld-vp'
import type { JwsSigner } from '@/services/jws'
import { readVault, writeVault, readPublicVault, writePublicVault, syncPublicVault } from '@/utils/vault'
import type { LinkedIdentity } from '@/stores/wallet'
import type { StoredCredential, ProofAccessRequest, PreparedPresentation, CredentialFormat } from '@/types/credential'
import { extractDidLabel } from '@/utils/did-label'
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
  notifyTab,
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
  sendDidSyncResponse,
  sendKeyRotateResponse,
  sendKeyBackupResponse,
  sendKeyRestoreResponse,
  sendReshareError,
} from '@/background/transport/tab-responses'

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

  // ── Approval window placement ──────────────────────
  // Position approval popups at the top-right of the focused window (Phantom/MetaMask style)
  // instead of Chrome's default (0, 0) which lands them in the corner of the display.
  async function computeApprovalPosition(
    width: number,
    height: number,
  ): Promise<{ left: number; top: number }> {
    try {
      const current = await chrome.windows.getCurrent()
      const winLeft = current.left ?? 0
      const winTop = current.top ?? 0
      const winWidth = current.width ?? 1280
      const winHeight = current.height ?? 800
      // Center the approval window over the active browser window.
      return {
        left: Math.max(0, Math.round(winLeft + (winWidth - width) / 2)),
        top: Math.max(0, Math.round(winTop + (winHeight - height) / 2)),
      }
    } catch {
      return { left: 100, top: 100 }
    }
  }

  // ── Approval window lifecycle tracking ─────────────
  // When the user dismisses an approval window without clicking approve/deny, we
  // must send an error back to the originating page so it doesn't hang. We also
  // run a per-request timeout backstop in case onRemoved never fires.
  //
  // Flow: open*Window registers a cleanup → user closes window OR backstop fires
  // → cleanup runs (page gets error, pending map is purged). On approve/deny,
  // the handler calls `unregister` BEFORE sending its response so the cleanup
  // becomes a no-op.

  const windowCleanups = new Map<number, () => void>()

  // 5 minutes — generous backstop. The page-side TIMEOUT_MS is 30s, so the page
  // will reject first in nearly all cases. This catches the pathological case
  // where chrome.windows.onRemoved never fires (extension crash, page closed
  // before popup, etc.) so pending maps don't leak forever.
  const PENDING_REQUEST_BACKSTOP_MS = 5 * 60 * 1000

  function registerApprovalWindow(
    windowId: number | undefined,
    cleanup: () => void,
  ): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null

    const unregister = (): void => {
      if (windowId !== undefined) windowCleanups.delete(windowId)
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const wrapped = (): void => {
      unregister()
      try {
        cleanup()
      } catch (err) {
        console.error('[Attestto ID] Approval window cleanup failed:', err)
      }
    }

    if (windowId !== undefined) {
      windowCleanups.set(windowId, wrapped)
    }
    timer = setTimeout(wrapped, PENDING_REQUEST_BACKSTOP_MS)
    return unregister
  }

  chrome.windows.onRemoved.addListener((windowId) => {
    const cleanup = windowCleanups.get(windowId)
    if (cleanup) cleanup()
  })

  /**
   * Open the dedicated approval window for a credential offer (identity sync OR VC issuance).
   * Replaces the OS-notification flow which is unreliable across platforms.
   */
  async function openCredentialOfferApprovalWindow(
    notifId: string,
    offer: CredentialOfferMessage['payload'],
    origin: string | null,
  ): Promise<void> {
    const params = new URLSearchParams({
      credentialOfferId: notifId,
      format: offer.format,
      issuerName: offer.issuerName,
      origin: origin ?? '',
    })
    const approvalUrl = chrome.runtime.getURL(`approval.html?${params.toString()}`)
    try {
      const pos = await computeApprovalPosition(420, 560)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 420,
        height: 560,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      // Credential offers are notification-style: the page sent CREDENTIAL_PUSH
      // and already got `pendingConsent: true`. No outstanding promise on the
      // page side, so cleanup just purges the local pending map.
      const unregister = registerApprovalWindow(win?.id, () => {
        pendingOffers.delete(notifId)
      })
      const pending = pendingOffers.get(notifId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto ID] Failed to open credential offer approval window:', err)
      pendingOffers.delete(notifId)
    }
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

  interface PendingChapiRequest {
    apiReq: CredentialApiRequestMessage['payload']
    holderDid: string
    vcs: Record<string, unknown>[]
    challenge: string
    domain: string
    privateKeyJwk: JsonWebKey
    verificationMethod?: string
    senderTabId: number | null
  }

  const pendingChapiRequests = new Map<string, PendingChapiRequest>()

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

  /**
   * Open the approval popup for a document signing request.
   */
  async function handleSigningRequest(
    signReq: SignDocumentRequestMessage['payload'],
    senderTabId: number | null,
  ): Promise<void> {
    pendingSigningRequests.set(signReq.requestId, { signReq, senderTabId })

    const params = new URLSearchParams({
      signingRequest: signReq.requestId,
      origin: signReq.origin || '',
      documentTitle: signReq.documentTitle || '',
      signerName: signReq.signerName || '',
    })

    const approvalUrl = chrome.runtime.getURL(`approval.html?${params.toString()}`)

    try {
      const pos = await computeApprovalPosition(380, 580)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 580,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        if (pendingSigningRequests.has(signReq.requestId)) {
          pendingSigningRequests.delete(signReq.requestId)
          sendSigningErrorToTab(senderTabId, signReq.requestId, 'User cancelled — approval window closed')
        }
      })
      const pending = pendingSigningRequests.get(signReq.requestId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto Sign] Failed to open signing approval window:', err)
      pendingSigningRequests.delete(signReq.requestId)
      sendSigningErrorToTab(senderTabId, signReq.requestId, 'Could not open approval window')
    }
  }

  /**
   * A gated JWS signer bound to a P-256 key — the background path for `createChapiVp`
   * so VP signing routes through the same gate as the extracted APPROVE cores (AD-11c).
   * The key import + `crypto.subtle.sign` live in the injected `es256RawSign` adapter
   * (Story 1.13 Phase 1b); the gate wraps it here. This is the LAST `createGatedSign`
   * left in the entrypoint — it goes when `completeChapiRequest` (the notification-flow
   * CHAPI path, its only caller) is extracted in a later phase. `assertPresence` is a
   * passthrough (parity) until the real WebAuthn gate is wired.
   */
  function gatedJwsSigner(privateJwk: JsonWebKey): JwsSigner {
    const sign = createGatedSign({ assertPresence: async () => {}, rawSign: (p) => es256RawSign(privateJwk, p) })
    return async (signingInput: Uint8Array) => (await sign(signingInput)).bytes
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

  /**
   * Transitional inline KeyAdmin ctx (Story 1.13 Phase 2) for the extracted
   * key-lifecycle cores (rotate/backup/restore): `store` = read/write/mirror via the
   * vault utils, `keygen` = P-256 generation. A fresh object per call. Consolidated
   * into `buildBundle('keyAdmin')` in a later phase, mirroring how signing moved in 1b.
   */
  const keyAdminCtx = () => ({
    store: { read: readVault, write: writeVault, syncPublic: syncPublicVault },
    keygen: {
      generateP256: async () => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
        return {
          privateKeyJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
          publicKeyJwk: await crypto.subtle.exportKey('jwk', kp.publicKey),
        }
      },
    },
  })

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

    const params = new URLSearchParams({
      authRequest: requestId,
      origin: origin || '',
    })
    if (siteName) params.set('siteName', siteName)

    const approvalUrl = chrome.runtime.getURL(`approval.html?${params.toString()}`)

    try {
      // Aligned with other approval modes (380 wide) after the compact-header
      // refactor — the old 420×620 was sized for the bigger hero card. Height
      // dropped to 460 to remove the empty bottom gap visible at 620.
      const pos = await computeApprovalPosition(380, 460)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 460,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        if (pendingAuthRequests.has(requestId)) {
          pendingAuthRequests.delete(requestId)
          sendError(senderTabId, requestId, 'User cancelled — approval window closed')
        }
      })
      const pending = pendingAuthRequests.get(requestId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto ID] Failed to open auth approval window:', err)
      pendingAuthRequests.delete(requestId)
      sendError(senderTabId, requestId, 'Could not open approval window')
    }
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

    const params = new URLSearchParams({
      attesttoPdfRequest: req.requestId,
      origin: req.origin || '',
      fileName: req.fileName || '',
      documentHash: req.documentHash || '',
    })

    const approvalUrl = chrome.runtime.getURL(`approval.html?${params.toString()}`)

    try {
      const pos = await computeApprovalPosition(380, 580)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 580,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        if (pendingAttesttoPdfRequests.has(req.requestId)) {
          pendingAttesttoPdfRequests.delete(req.requestId)
          sendAttesttoPdfErrorToTab(senderTabId, req.requestId, 'User cancelled — approval window closed')
        }
      })
      const pending = pendingAttesttoPdfRequests.get(req.requestId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto Sign] Failed to open Attestto PDF approval window:', err)
      pendingAttesttoPdfRequests.delete(req.requestId)
      sendAttesttoPdfErrorToTab(senderTabId, req.requestId, 'Could not open approval window')
    }
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

    const params = new URLSearchParams({
      paymentRequest: payReq.requestId,
      origin: payReq.origin || '',
      amount: String(payReq.amount),
      currency: payReq.currency || 'USDC',
      merchant: payReq.merchantName || '',
    })

    const approvalUrl = chrome.runtime.getURL(`approval.html?${params.toString()}`)

    try {
      const pos = await computeApprovalPosition(380, 580)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 580,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        if (pendingPaymentRequests.has(payReq.requestId)) {
          pendingPaymentRequests.delete(payReq.requestId)
          sendPaymentErrorToTab(senderTabId, payReq.requestId, 'User cancelled — approval window closed')
        }
      })
      const pending = pendingPaymentRequests.get(payReq.requestId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto Pay] Failed to open payment approval window:', err)
      pendingPaymentRequests.delete(payReq.requestId)
      sendPaymentErrorToTab(senderTabId, payReq.requestId, 'Could not open approval window')
    }
  }

  /**
   * Accept a credential offer: parse, store in vault, notify popup.
   */
  async function acceptCredentialOffer(
    notificationId: string,
  ): Promise<string | null> {
    const pending = pendingOffers.get(notificationId)
    if (!pending) return null
    const { offer, origin } = pending
    pendingOffers.delete(notificationId)

    // Identity-format sync from a freshly-approved origin: remember it so the
    // next offer from this origin can be accepted silently. Other formats
    // (sd-jwt, json-ld) are one-off issuance events, not recurring sync — no
    // benefit to persisting trust for them.
    if (offer.format === 'attestto-id' && origin) {
      await recordTrustedOrigin(origin)
    }

    try {
      let decodedClaims: Record<string, unknown> = {}
      let types: string[] = ['VerifiableCredential']
      let issuer = offer.issuerName
      let issuedAt = new Date().toISOString()
      let expiresAt: string | null = null
      const disclosureDigests: string[] = []

      if (offer.format === 'sd-jwt') {
        const parsed = await parseSdJwt(offer.raw)
        decodedClaims = await getDecodedClaims(offer.raw)
        types = (parsed.payload.vct as string[]) ?? types
        issuer = (parsed.payload.iss as string) ?? issuer
        issuedAt = parsed.payload.iat
          ? new Date((parsed.payload.iat as number) * 1000).toISOString()
          : issuedAt
        expiresAt = parsed.payload.exp
          ? new Date((parsed.payload.exp as number) * 1000).toISOString()
          : null
        parsed.disclosures.forEach((d) => {
          // Disclosure exposes the computed digest as the cached `_digest`
          // string (populated during decode); `digest()` is the async recompute.
          if (d._digest) disclosureDigests.push(d._digest)
        })
      } else {
        // JSON-LD or attestto-id format
        try {
          const vc = JSON.parse(offer.raw) as Record<string, unknown>
          decodedClaims = (vc.credentialSubject as Record<string, unknown>) ?? vc
          types = (vc.type as string[]) ?? types
          issuer = (typeof vc.issuer === 'string' ? vc.issuer : (vc.issuer as Record<string, unknown>)?.id as string) ?? issuer
          issuedAt = (vc.issuanceDate as string) ?? issuedAt
          expiresAt = (vc.expirationDate as string) ?? null
        } catch {
          // Raw claims object (from attestto-id push)
          decodedClaims = offer.claims ?? {}
        }
      }

      const credential: StoredCredential = {
        id: crypto.randomUUID(),
        // Wire payload types format as `CredentialFormat | string` (accepts
        // unknown formats); storage coerces to the known enum at this boundary.
        format: offer.format as CredentialFormat,
        raw: offer.raw,
        issuer,
        issuedAt,
        expiresAt,
        types: Array.isArray(types) ? types : [types],
        decodedClaims,
        metadata: {
          addedAt: new Date().toISOString(),
          source: 'push',
          disclosureDigests: disclosureDigests.length > 0 ? disclosureDigests : undefined,
        },
      }

      // Identity-format offers (attestto-id) carry a didUri that should populate
      // linkedIdentities[] so the popup's IdentityListView shows the identity.
      // The credential itself is still stored for record-keeping.
      const identityDid = offer.format === 'attestto-id'
        ? (decodedClaims.didUri as string | undefined)
        : undefined

      // Store in public vault (always works, no passkey needed). Create an
      // empty public vault if the read returned null — otherwise the offer
      // silently disappears, which is exactly the bug that "I pushed an
      // identity and nothing showed up" was hiding.
      const pub = (await readPublicVault()) ?? {
        did: null,
        credentials: [],
        linkedSolanaAddress: null,
        keyShares: [],
        proofRequests: [],
        preparedPresentations: [],
      }
      pub.credentials = [...(pub.credentials ?? []), credential]
      if (identityDid) {
        pub.linkedIdentities = upsertIdentity(
          pub.linkedIdentities ?? [],
          identityDid,
          credential,
        )
      }
      await writePublicVault(pub)

      // Also store in encrypted vault if unlocked
      const vault = await readVault()
      if (vault) {
        vault.credentials = [...(vault.credentials ?? []), credential]
        if (identityDid) {
          vault.linkedIdentities = upsertIdentity(
            vault.linkedIdentities ?? [],
            identityDid,
            credential,
          )
        }
        await writeVault(vault)
        await syncPublicVault(vault)
      }

      return credential.id
    } catch {
      return null
    }
  }

  /**
   * Upsert an identity DID into linkedIdentities[], attaching the credential
   * that carried it. Used by acceptCredentialOffer for `attestto-id` format.
   */
  function upsertIdentity(
    list: LinkedIdentity[],
    did: string,
    credential: StoredCredential,
  ): LinkedIdentity[] {
    const now = new Date().toISOString()
    const idx = list.findIndex((id) => id.did === did)
    if (idx >= 0) {
      const existing = list[idx]
      const hasCred = existing.credentials.some((c) => c.id === credential.id)
      return list.map((id, i) =>
        i === idx
          ? {
              ...id,
              syncedAt: now,
              credentials: hasCred ? id.credentials : [...id.credentials, credential],
            }
          : id,
      )
    }
    return [
      ...list,
      {
        did,
        label: extractDidLabel(did),
        credentials: [credential],
        syncedAt: now,
        tenantId: null,
      },
    ]
  }

  // ── Notification Button Handling ───────────────────

  chrome.notifications.onButtonClicked.addListener(
    (notificationId, buttonIndex) => {
      // CHAPI consent notifications
      if (pendingChapiRequests.has(notificationId)) {
        if (buttonIndex === 0) {
          completeChapiRequest(notificationId)
        } else {
          denyChapiRequest(notificationId)
        }
        chrome.notifications.clear(notificationId)
        return
      }

      // Credential offer notifications
      if (buttonIndex === 0) {
        // Accept
        acceptCredentialOffer(notificationId).then((credentialId) => {
          if (credentialId) {
            chrome.runtime.sendMessage({
              type: 'CREDENTIAL_ACCEPTED',
              payload: { credentialId },
            })
          }
        })
      } else {
        // Reject
        pendingOffers.delete(notificationId)
        chrome.runtime.sendMessage({
          type: 'CREDENTIAL_REJECTED',
          payload: { reason: 'User declined' },
        })
      }
      chrome.notifications.clear(notificationId)
    },
  )

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

    const approvalUrl = chrome.runtime.getURL(
      `approval.html?chapiRequest=${encodeURIComponent(apiReq.requestId)}&origin=${encodeURIComponent(apiReq.origin || '')}`
    )

    try {
      const pos = await computeApprovalPosition(380, 520)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 520,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        if (pendingChapiRawRequests.has(apiReq.requestId)) {
          pendingChapiRawRequests.delete(apiReq.requestId)
          sendChapiErrorToTab(senderTabId, apiReq.requestId, 'User cancelled — approval window closed')
        }
      })
      const pending = pendingChapiRawRequests.get(apiReq.requestId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto ID] Failed to open approval window:', err)
      pendingChapiRawRequests.delete(apiReq.requestId)
      sendChapiErrorToTab(senderTabId, apiReq.requestId, 'Could not open approval window')
    }
  }

  /**
   * Send a CHAPI error to the originating tab. tabId MUST be the sender.tab.id
   * captured at request-receipt time — never the active-tab fallback (that would
   * route the error to whatever tab the user is currently looking at).
   */
  async function completeChapiRequest(notifId: string): Promise<void> {
    const pending = pendingChapiRequests.get(notifId)
    if (!pending) return
    pendingChapiRequests.delete(notifId)

    try {
      const vp = await createChapiVp({
        credentials: pending.vcs,
        holderDid: pending.holderDid,
        sign: gatedJwsSigner(pending.privateKeyJwk),
        challenge: pending.challenge,
        domain: pending.domain,
        verificationMethod: pending.verificationMethod,
      })

      if (pending.senderTabId) {
        notifyTab(pending.senderTabId, {
          type: 'CREDENTIAL_API_RESPONSE',
          payload: { requestId: pending.apiReq.requestId, presentation: vp },
        })
      } else {
        console.warn('[Attestto ID] Dropping CHAPI VP — no originating tabId', {
          requestId: pending.apiReq.requestId,
        })
      }
    } catch {
      sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, 'Failed to build presentation')
    }
  }

  function denyChapiRequest(notifId: string): void {
    const pending = pendingChapiRequests.get(notifId)
    if (!pending) return
    pendingChapiRequests.delete(notifId)
    sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, 'User declined')
  }

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
        const notifId = message.payload?.notifId as string | undefined
        if (!notifId) {
          sendResponse({ ok: false, error: 'No notifId provided' })
          break
        }
        const pending = pendingOffers.get(notifId)
        if (!pending) {
          sendResponse({ ok: false, error: 'Offer not found or already handled' })
          break
        }
        sendResponse({
          ok: true,
          offer: {
            format: pending.offer.format,
            issuerName: pending.offer.issuerName,
          },
          origin: pending.origin,
        })
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
        const notifId = message.payload?.notifId as string | undefined
        if (notifId) {
          pendingOffers.get(notifId)?.unregister?.()
          pendingOffers.delete(notifId)
        }
        sendResponse({ ok: true })
        break
      }

      case 'CREDENTIAL_OFFER': {
        console.log('[Attestto ID] CREDENTIAL_OFFER received in background', message.payload)
        const offer = message.payload as CredentialOfferMessage['payload']
        const senderOrigin = sender?.origin ?? sender?.url ?? null
        const notifId = `credential-offer-${Date.now()}`
        pendingOffers.set(notifId, { offer, origin: senderOrigin })

        // Identity-format offers (attestto-id): auto-accept ONLY if the user
        // previously approved this origin. Untrusted origins (or any non-identity
        // format) route through the dedicated approval window — reliable across
        // platforms, unlike OS notifications which silently fail on macOS Brave.
        if (offer.format === 'attestto-id') {
          isOriginTrusted(senderOrigin).then((trusted) => {
            if (trusted) {
              acceptCredentialOffer(notifId).then((credentialId) => {
                console.log('[Attestto ID] Identity offer auto-accepted (trusted origin):', credentialId)
              })
              sendResponse({ ok: true, autoAccepted: true })
              return
            }
            openCredentialOfferApprovalWindow(notifId, offer, senderOrigin)
            sendResponse({ ok: true, pendingConsent: true })
          })
          return true // keep sendResponse channel open for async trust check
        }

        // Non-identity formats (sd-jwt, json-ld) — also route through approval window.
        openCredentialOfferApprovalWindow(notifId, offer, senderOrigin)
        sendResponse({ ok: true, pendingConsent: true })
        break
      }

      case 'WALLET_LINK': {
        const address = message.payload?.address as string | undefined
        if (address) {
          readVault().then(async (vault) => {
            if (vault) {
              vault.linkedSolanaAddress = address
              await writeVault(vault)
              await syncPublicVault(vault)
            }
            sendResponse({ ok: true })
          })
        } else {
          sendResponse({ ok: false, error: 'No address provided' })
        }
        break
      }

      case 'PROOF_ACCESS_REQUEST': {
        const par = message.payload as ProofAccessRequestMessage['payload']
        const proofRequest: ProofAccessRequest = {
          id: `par-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          credentialId: par.credentialId,
          requesterDid: par.requesterDid,
          requesterName: par.requesterName,
          purpose: par.purpose,
          requestedFields: par.requestedFields,
          approvedFields: [],
          status: 'pending',
          receivedAt: new Date().toISOString(),
          decidedAt: null,
          expiresAt: par.expiresAt,
          transport: par.transport,
          nonce: par.nonce,
          audience: par.audience,
        }

        // Store in vault
        readVault().then(async (vault) => {
          if (vault) {
            vault.proofRequests = [...(vault.proofRequests ?? []), proofRequest]
            await writeVault(vault)
            await syncPublicVault(vault)
          }
        })

        // Show notification
        chrome.notifications.create(proofRequest.id, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/48.png'),
          title: 'Proof Access Request',
          message: `${par.requesterName} is requesting access to ${par.requestedFields.length} field(s).`,
          buttons: [{ title: 'Review' }, { title: 'Dismiss' }],
          requireInteraction: true,
        })

        sendResponse({ ok: true, requestId: proofRequest.id })
        break
      }

      case 'PUSH_PRESENTATION': {
        const push = message.payload as PushPresentationMessage['payload']
        const prep: PreparedPresentation = {
          id: `prep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          credentialId: push.credentialId,
          presentation: push.presentation,
          selectedFields: push.selectedFields,
          createdAt: new Date().toISOString(),
          expiresAt: push.expiresAt,
          used: false,
          usedAt: null,
        }

        readVault().then(async (vault) => {
          if (vault) {
            vault.preparedPresentations = [...(vault.preparedPresentations ?? []), prep]
            await writeVault(vault)
            await syncPublicVault(vault)
          }
          sendResponse({ ok: true, preparedId: prep.id })
        })

        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/48.png'),
          title: 'Presentation Ready',
          message: `A prepared presentation with ${push.selectedFields.length} field(s) is ready in your vault.`,
        })
        break
      }

      case 'DIDCOMM_INBOUND': {
        // Story 1.9 — extracted to the DIDCOMM_INBOUND route (parity-tested in
        // didcomm-inbound.handler.spec). Delegates DIRECTLY to `handle` (not
        // through `dispatch`, whose empty `allowFrom` would reject — the legacy
        // case did no sender-auth). Effects fire-and-forget, response stays sync —
        // same as before. The inline ctx is a thin chrome adapter; the real
        // capability-scoped bundle is built by the composition root (Story 1.13),
        // which also removes this cast.
        const didcommCtx: Pick<UntrustedCtx, 'notifications' | 'runtime'> = {
          notifications: {
            create: async (id, options) => {
              chrome.notifications.create(id, options as chrome.notifications.NotificationOptions<true>)
            },
          },
          runtime: {
            sendMessage: async (msg) => { chrome.runtime.sendMessage(msg) },
            getURL: (path) => chrome.runtime.getURL(path),
          },
        }
        void MESSAGE_ROUTES.DIDCOMM_INBOUND.handle(
          (message as DIDCommInboundMessage).payload,
          didcommCtx as never,
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
          const creds = (vault?.credentials ?? []).map((c: StoredCredential) => ({
            id: c.id,
            format: c.format,
            issuer: c.issuer,
            issuedAt: c.issuedAt,
            expiresAt: c.expiresAt,
            types: c.types,
            claimKeys: Object.keys(c.decodedClaims),
            source: c.metadata.source,
          }))

          if (listSenderTabId) {
            notifyTab(listSenderTabId, {
              type: 'LIST_STORED_CREDENTIALS_RESPONSE',
              payload: { requestId: listReqId, credentials: creds },
            })
          } else {
            console.warn('[Attestto ID] Dropping LIST_STORED_CREDENTIALS_RESPONSE — no originating tabId', { requestId: listReqId })
          }
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

        readVault().then(async (vault) => {
          if (!vault) {
            sendReshareError(reshareSenderTabId, resharePayload.requestId, 'Vault locked')
            sendResponse({ ok: false })
            return
          }

          const cred = (vault.credentials ?? []).find(
            (c: StoredCredential) => c.id === resharePayload.credentialId,
          )
          if (!cred) {
            sendReshareError(reshareSenderTabId, resharePayload.requestId, 'Credential not found')
            sendResponse({ ok: false })
            return
          }

          // Build a filtered claims object for the selected fields
          const filteredClaims: Record<string, unknown> = {}
          for (const field of resharePayload.selectedFields) {
            if (field in cred.decodedClaims) {
              filteredClaims[field] = cred.decodedClaims[field]
            }
          }

          if (reshareSenderTabId) {
            notifyTab(reshareSenderTabId, {
              type: 'RESHARE_STORED_VP_RESPONSE',
              payload: {
                requestId: resharePayload.requestId,
                presentation: {
                  credentialId: cred.id,
                  format: cred.format,
                  issuer: cred.issuer,
                  selectedFields: resharePayload.selectedFields,
                  claims: filteredClaims,
                  issuedAt: cred.issuedAt,
                  expiresAt: cred.expiresAt,
                },
              },
            })
          } else {
            console.warn('[Attestto ID] Dropping RESHARE_STORED_VP_RESPONSE — no originating tabId', { requestId: resharePayload.requestId })
          }
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
          store: {
            read: () => readVault(),
            write: (v) => writeVault(v),
            syncPublic: (v) => syncPublicVault(v),
          },
          keygen: {
            generateP256: async () => {
              const keyPair = await crypto.subtle.generateKey(
                { name: 'ECDSA', namedCurve: 'P-256' },
                true,
                ['sign', 'verify'],
              )
              return {
                privateKeyJwk: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
                publicKeyJwk: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
              }
            },
          },
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
        handleKeyRotate(keyAdminCtx()).then((result) => {
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
        handleKeyBackup(keyAdminCtx()).then((result) => {
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
        handleKeyRestore({ shareA: restoreReq.shareA, shareB: restoreReq.shareB }, keyAdminCtx()).then((result) => {
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

      case 'SIGN_DOCUMENT_GET_PENDING': {
        const signReqId = message.payload?.requestId as string
        const pendingSign = pendingSigningRequests.get(signReqId)
        if (pendingSign) {
          sendResponse({ ok: true, request: pendingSign })
        } else {
          sendResponse({ ok: false, error: 'No pending signing request found' })
        }
        break
      }

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

      case 'SIGN_DOCUMENT_DENY': {
        const signDenyId = message.payload?.requestId as string
        const pendingSignDeny = pendingSigningRequests.get(signDenyId)
        if (pendingSignDeny) {
          pendingSignDeny.unregister?.()
          pendingSigningRequests.delete(signDenyId)
          sendSigningErrorToTab(pendingSignDeny.senderTabId, pendingSignDeny.signReq.requestId, 'User declined signing')
        }
        sendResponse({ ok: true })
        break
      }

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

      case 'AUTH_GET_PENDING': {
        const authReqId = message.payload?.requestId as string
        const pendingAuth = pendingAuthRequests.get(authReqId)
        if (pendingAuth) {
          sendResponse({ ok: true, request: pendingAuth })
        } else {
          sendResponse({ ok: false, error: 'No pending auth request found' })
        }
        break
      }

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

      case 'AUTH_DENY': {
        const authDenyId = message.payload?.requestId as string
        const pendingAuthDeny = pendingAuthRequests.get(authDenyId)
        if (pendingAuthDeny) {
          pendingAuthDeny.unregister?.()
          pendingAuthRequests.delete(authDenyId)
          // Route the denial back on the SAME protocol the request arrived on.
          // A cw (credential-wallet:auth) request must get a CW_AUTH_RESPONSE so
          // the MAIN-world listener resolves requestAuth immediately; sending the
          // legacy AUTH_RESPONSE would leave it hanging until its 120s timeout.
          const denyErr =
            pendingAuthDeny.protocol === 'cw' ? sendCwAuthErrorToTab : sendAuthErrorToTab
          denyErr(pendingAuthDeny.senderTabId, pendingAuthDeny.requestId, 'User declined')
        }
        sendResponse({ ok: true })
        break
      }

      // ── Attestto self-attested PDF signing (ATT-364) ───────────────

      case 'SIGN_ATTESTTO_PDF_REQUEST': {
        const apdfReq = message.payload as SignAttesttoPdfRequestMessage['payload']
        handleAttesttoPdfRequest(apdfReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      case 'SIGN_ATTESTTO_PDF_GET_PENDING': {
        const apdfId = message.payload?.requestId as string
        const pendingApdf = pendingAttesttoPdfRequests.get(apdfId)
        if (pendingApdf) {
          sendResponse({ ok: true, request: pendingApdf })
        } else {
          sendResponse({ ok: false, error: 'No pending Attestto PDF sign request found' })
        }
        break
      }

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

      case 'SIGN_ATTESTTO_PDF_DENY': {
        const apdfDenyId = message.payload?.requestId as string
        const pendingApdfDeny = pendingAttesttoPdfRequests.get(apdfDenyId)
        if (pendingApdfDeny) {
          pendingApdfDeny.unregister?.()
          pendingAttesttoPdfRequests.delete(apdfDenyId)
          sendAttesttoPdfErrorToTab(pendingApdfDeny.senderTabId, pendingApdfDeny.req.requestId, 'User declined signing')
        }
        sendResponse({ ok: true })
        break
      }

      // ── Payment Request Handler ──

      case 'PAYMENT_REQUEST': {
        const payReq = message.payload as PaymentRequestMessage['payload']
        handlePaymentRequest(payReq, sender.tab?.id ?? null).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      // ── Payment Popup Handlers (DID-authenticated payment flow) ──

      case 'PAYMENT_GET_PENDING': {
        const payReqId = message.payload?.requestId as string
        const pendingPay = pendingPaymentRequests.get(payReqId)
        if (pendingPay) {
          sendResponse({ ok: true, request: pendingPay })
        } else {
          sendResponse({ ok: false, error: 'No pending payment request found' })
        }
        break
      }

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

      case 'PAYMENT_DENY': {
        const payDenyId = message.payload?.requestId as string
        const pendingPayDeny = pendingPaymentRequests.get(payDenyId)
        if (pendingPayDeny) {
          pendingPayDeny.unregister?.()
          pendingPaymentRequests.delete(payDenyId)
          sendPaymentErrorToTab(pendingPayDeny.senderTabId, pendingPayDeny.payReq.requestId, 'User declined payment')
        }
        sendResponse({ ok: true })
        break
      }

      // ── CHAPI Popup Handlers (Phantom-style approval flow) ──

      case 'CHAPI_GET_PENDING': {
        const chapiReqId = message.payload?.requestId as string
        const rawReq = pendingChapiRawRequests.get(chapiReqId)
        if (rawReq) {
          sendResponse({ ok: true, request: rawReq })
        } else {
          sendResponse({ ok: false, error: 'No pending request found' })
        }
        break
      }

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
            if (pending.senderTabId) {
              notifyTab(pending.senderTabId, {
                type: 'CREDENTIAL_API_RESPONSE',
                payload: { requestId: pending.apiReq.requestId, presentation: result.presentation },
              })
            }
            sendResponse({ ok: true, holderDid: result.holderDid })
          } else {
            sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, result.tabError ?? result.error)
            sendResponse({ ok: false, error: result.error })
          }
        })
        break
      }

      case 'CHAPI_DENY': {
        const denyReqId = message.payload?.requestId as string
        const pendingDeny = pendingChapiRawRequests.get(denyReqId)
        if (pendingDeny) {
          pendingDeny.unregister?.()
          pendingChapiRawRequests.delete(denyReqId)
          sendChapiErrorToTab(pendingDeny.senderTabId, pendingDeny.apiReq.requestId, 'User declined')
        }
        sendResponse({ ok: true })
        break
      }

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
