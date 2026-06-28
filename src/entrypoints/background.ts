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

import { signPayload } from '@/services/signing'
import { parseSdJwt, getDecodedClaims } from '@/services/sdjwt'
import { parseProofRequest } from '@/services/didcomm'
import { createChapiVp } from '@/services/jsonld-vp'
import { readVault, writeVault, readPublicVault, writePublicVault, syncPublicVault } from '@/utils/vault'
import type { LinkedIdentity } from '@/stores/wallet'
import type { StoredCredential, ProofAccessRequest, PreparedPresentation } from '@/types/credential'
import { publicJwkToDid, didJwkVerificationMethod } from '@/utils/did-jwk'
import type { CredentialOfferMessage, PushPresentationMessage, ProofAccessRequestMessage, CredentialApiRequestMessage, DIDCommInboundMessage, DidSyncMessage, KeyRotateMessage, KeyBackupMessage, KeyRestoreMessage, PaymentRequestMessage, SignDocumentRequestMessage, SignAttesttoPdfRequestMessage } from '@/utils/messaging'
import { split2of3, combine2of3, toBase64Url, fromBase64Url } from '@/services/shamir'
import { isOriginTrusted, recordTrustedOrigin } from '@/utils/trusted-origins'

export default defineBackground(() => {
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
      void height
      return {
        left: Math.max(0, Math.round(winLeft + winWidth - width - 16)),
        top: Math.max(0, Math.round(winTop + 80)),
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

  // Set up auto-lock alarm from stored preference
  async function resetAutoLockAlarm(): Promise<void> {
    const stored = await chrome.storage.local.get('attestto_ext_auto_lock_minutes')
    const minutes = Number(stored.attestto_ext_auto_lock_minutes) || 5
    chrome.alarms.create('autoLock', { delayInMinutes: minutes })
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

  function sendSigningErrorToTab(tabId: number | null, requestId: string, error: string): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SIGN_DOCUMENT_RESPONSE',
        payload: { requestId, error },
      })
    }
  }

  function sendSigningResponseToTab(
    tabId: number | null,
    requestId: string,
    data: { did: string; signature: string; publicKeyJwk: Record<string, string>; timestamp: string },
  ): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SIGN_DOCUMENT_RESPONSE',
        payload: { requestId, ...data },
      })
    }
  }

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
    pendingAuthRequests.set(authReq.requestId, { ...authReq, senderTabId })

    const params = new URLSearchParams({
      authRequest: authReq.requestId,
      origin: authReq.origin || '',
    })

    const approvalUrl = chrome.runtime.getURL(`approval.html?${params.toString()}`)

    try {
      const pos = await computeApprovalPosition(420, 620)
      const win = await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 420,
        height: 620,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        if (pendingAuthRequests.has(authReq.requestId)) {
          pendingAuthRequests.delete(authReq.requestId)
          sendAuthErrorToTab(senderTabId, authReq.requestId, 'User cancelled — approval window closed')
        }
      })
      const pending = pendingAuthRequests.get(authReq.requestId)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error('[Attestto ID] Failed to open auth approval window:', err)
      pendingAuthRequests.delete(authReq.requestId)
      sendAuthErrorToTab(senderTabId, authReq.requestId, 'Could not open approval window')
    }
  }

  function sendAuthErrorToTab(tabId: number | null, requestId: string, error: string): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'AUTH_RESPONSE',
        payload: { requestId, error },
      })
    }
  }

  function sendAuthResponseToTab(
    tabId: number | null,
    requestId: string,
    data: { did: string; signature: string; nonce: string; timestamp: string; publicKeyJwk: Record<string, string> },
  ): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'AUTH_RESPONSE',
        payload: { requestId, ...data },
      })
    }
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

  function sendAttesttoPdfErrorToTab(tabId: number | null, requestId: string, error: string): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SIGN_ATTESTTO_PDF_RESPONSE',
        payload: { requestId, error },
      })
    }
  }

  function sendAttesttoPdfResponseToTab(
    tabId: number | null,
    requestId: string,
    data: { did: string; signature: string; publicKey: string },
  ): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'SIGN_ATTESTTO_PDF_RESPONSE',
        payload: { requestId, ...data },
      })
    }
  }

  /**
   * Get or lazily create the vault's Ed25519 keypair (ATT-364).
   *
   * Lives alongside the legacy P-256 key — does NOT replace it. Used
   * exclusively for Attestto self-attested PDF signing where the
   * verifier only accepts Ed25519. Persists across sessions.
   *
   * Returns the unwrapped CryptoKey ready to sign + the raw 32-byte
   * public key as base64.
   */
  async function getOrCreateEd25519Key(): Promise<{
    privateKey: CryptoKey
    publicKeyB64: string
  } | null> {
    const vault = await readVault()
    if (!vault) return null

    if (vault.ed25519PrivateKeyJwk && vault.ed25519PublicKeyB64) {
      try {
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          vault.ed25519PrivateKeyJwk,
          { name: 'Ed25519' },
          false,
          ['sign'],
        )
        return { privateKey, publicKeyB64: vault.ed25519PublicKeyB64 }
      } catch (err) {
        console.warn('[Attestto Sign] Existing Ed25519 key import failed, regenerating:', err)
      }
    }

    // First-time generation. Web Crypto Ed25519 is supported in
    // Chromium 113+ / Firefox 130+ / Safari 17+.
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair

    const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
    const publicKeyB64 = btoa(String.fromCharCode(...rawPub))

    vault.ed25519PrivateKeyJwk = privateKeyJwk
    vault.ed25519PublicKeyB64 = publicKeyB64
    await writeVault(vault)

    return { privateKey: keyPair.privateKey, publicKeyB64 }
  }

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

  function sendPaymentErrorToTab(tabId: number | null, requestId: string, error: string): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'PAYMENT_RESPONSE',
        payload: { requestId, error },
      })
    }
  }

  function sendPaymentResponseToTab(
    tabId: number | null,
    requestId: string,
    data: { did: string; signature: string; publicKeyJwk: Record<string, string> },
  ): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'PAYMENT_RESPONSE',
        payload: { requestId, ...data },
      })
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
          if (d.digest) disclosureDigests.push(d.digest)
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
        format: offer.format,
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
        label: extractDidLabelForSync(did),
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

  function sendChapiError(requestId: string, error: string): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'CREDENTIAL_API_RESPONSE',
          payload: { requestId, error },
        })
      }
    })
  }

  /** Send CHAPI error to a specific tab (used when popup is open and active tab is the popup) */
  function sendChapiErrorToTab(tabId: number | null, requestId: string, error: string): void {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'CREDENTIAL_API_RESPONSE',
        payload: { requestId, error },
      })
    } else {
      sendChapiError(requestId, error)
    }
  }

  async function completeChapiRequest(notifId: string): Promise<void> {
    const pending = pendingChapiRequests.get(notifId)
    if (!pending) return
    pendingChapiRequests.delete(notifId)

    try {
      const vp = await createChapiVp({
        credentials: pending.vcs,
        holderDid: pending.holderDid,
        holderPrivateKey: pending.privateKeyJwk,
        challenge: pending.challenge,
        domain: pending.domain,
        verificationMethod: pending.verificationMethod,
      })

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'CREDENTIAL_API_RESPONSE',
            payload: { requestId: pending.apiReq.requestId, presentation: vp },
          })
        }
      })
    } catch {
      sendChapiError(pending.apiReq.requestId, 'Failed to build presentation')
    }
  }

  function denyChapiRequest(notifId: string): void {
    const pending = pendingChapiRequests.get(notifId)
    if (!pending) return
    pendingChapiRequests.delete(notifId)
    sendChapiError(pending.apiReq.requestId, 'User declined')
  }

  // ── DID Sync Handler ───────────────────────────────────

  /**
   * Handle DID sync from the platform.
   *
   * The platform pushes a holderDid + verificationMethod after DID assignment.
   * We store them in the vault and return the extension's public JWK so the
   * platform can include it in the DID Document.
   *
   * If the vault has no keypair yet, we generate one (same as createDid flow).
   */
  async function handleDidSync(
    syncReq: DidSyncMessage['payload'],
  ): Promise<void> {
    const vault = await readVault()
    if (!vault) {
      sendDidSyncResponse(syncReq.requestId, null, null, 'Vault is locked')
      return
    }

    // Generate keypair if none exists
    if (!vault.privateKeyJwk) {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      )
      vault.privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

      // Also set the self-issued did:jwk as fallback DID if none set
      if (!vault.did) {
        const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
        vault.did = publicJwkToDid(publicJwk)
      }
    }

    // Extract public key from private JWK (strip private fields)
    const publicKeyJwk: JsonWebKey = {
      kty: vault.privateKeyJwk.kty,
      crv: vault.privateKeyJwk.crv,
      x: vault.privateKeyJwk.x,
      y: vault.privateKeyJwk.y,
    }

    // Keep legacy fields for backward compat
    vault.holderDid = syncReq.holderDid
    vault.verificationMethod = syncReq.verificationMethod

    // Upsert into linkedIdentities[]
    if (!vault.linkedIdentities) vault.linkedIdentities = []

    const existingIdx = vault.linkedIdentities.findIndex(
      (id) => id.did === syncReq.holderDid,
    )

    const label = extractDidLabelForSync(syncReq.holderDid)
    const now = new Date().toISOString()

    if (existingIdx >= 0) {
      vault.linkedIdentities[existingIdx].verificationMethod = syncReq.verificationMethod
      vault.linkedIdentities[existingIdx].syncedAt = now
      if (syncReq.tenantId) {
        vault.linkedIdentities[existingIdx].tenantId = syncReq.tenantId
      }
    } else {
      vault.linkedIdentities.push({
        did: syncReq.holderDid,
        label,
        verificationMethod: syncReq.verificationMethod,
        credentials: [],
        syncedAt: now,
        tenantId: syncReq.tenantId ?? null,
      })
    }

    await writeVault(vault)
    await syncPublicVault(vault)

    sendDidSyncResponse(syncReq.requestId, publicKeyJwk, syncReq.holderDid, null)
  }

  /** Extract a human-readable label from a DID. */
  function extractDidLabelForSync(did: string): string {
    const snsMatch = did.match(/^did:sns:(.+)$/)
    if (snsMatch) return snsMatch[1]

    const webMatch = did.match(/^did:web:(.+)$/)
    if (webMatch) return webMatch[1].replace(/:/g, '/')

    return did
  }

  function sendDidSyncResponse(
    requestId: string,
    publicKeyJwk: JsonWebKey | null,
    holderDid: string | null,
    error: string | null,
  ): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'DID_SYNC_RESPONSE',
          payload: { requestId, publicKeyJwk, holderDid, error },
        })
      }
    })
  }

  // ── Key Rotation (Phase D) ──────────────────────────

  async function handleKeyRotate(
    rotateReq: KeyRotateMessage['payload'],
  ): Promise<void> {
    const vault = await readVault()
    if (!vault) {
      sendKeyRotateResponse(rotateReq.requestId, null, null, 'Vault is locked')
      return
    }

    if (!vault.privateKeyJwk) {
      sendKeyRotateResponse(rotateReq.requestId, null, null, 'No existing key to rotate')
      return
    }

    // Capture old public key before overwriting
    const oldPublicKeyJwk: JsonWebKey = {
      kty: vault.privateKeyJwk.kty,
      crv: vault.privateKeyJwk.crv,
      x: vault.privateKeyJwk.x,
      y: vault.privateKeyJwk.y,
    }

    // Generate fresh P-256 keypair
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )

    vault.privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)

    // Update self-issued did:jwk to match new key
    const newPublicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    vault.did = publicJwkToDid(newPublicJwk)

    await writeVault(vault)

    const newPublicKeyJwk: JsonWebKey = {
      kty: newPublicJwk.kty,
      crv: newPublicJwk.crv,
      x: newPublicJwk.x,
      y: newPublicJwk.y,
    }

    sendKeyRotateResponse(rotateReq.requestId, newPublicKeyJwk, oldPublicKeyJwk, null)
  }

  function sendKeyRotateResponse(
    requestId: string,
    newPublicKeyJwk: JsonWebKey | null,
    oldPublicKeyJwk: JsonWebKey | null,
    error: string | null,
  ): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'KEY_ROTATE_RESPONSE',
          payload: { requestId, newPublicKeyJwk, oldPublicKeyJwk, error },
        })
      }
    })
  }

  // ── Key Backup / Restore (Phase E) ─────────────────

  async function handleKeyBackup(
    backupReq: KeyBackupMessage['payload'],
  ): Promise<void> {
    const vault = await readVault()
    if (!vault) {
      sendKeyBackupResponse(backupReq.requestId, null, 'Vault is locked')
      return
    }

    if (!vault.privateKeyJwk) {
      sendKeyBackupResponse(backupReq.requestId, null, 'No private key to back up')
      return
    }

    // Serialize the private key JWK to bytes
    const keyBytes = new TextEncoder().encode(JSON.stringify(vault.privateKeyJwk))

    // Split into 2-of-3 Shamir shares
    const [share1, share2, share3] = split2of3(keyBytes)

    // Compute a hash of the original key for verification after reconstruction
    const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes)
    const hashArray = new Uint8Array(hashBuffer)
    const keyHash = toBase64Url(hashArray)

    sendKeyBackupResponse(backupReq.requestId, {
      deviceShare: { data: toBase64Url(share1), index: 1 },
      cloudShare: { data: toBase64Url(share2), index: 2 },
      guardianShare: { data: toBase64Url(share3), index: 3 },
      keyHash,
    }, null)
  }

  function sendKeyBackupResponse(
    requestId: string,
    shares: {
      deviceShare: { data: string; index: number }
      cloudShare: { data: string; index: number }
      guardianShare: { data: string; index: number }
      keyHash: string
    } | null,
    error: string | null,
  ): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'KEY_BACKUP_RESPONSE',
          payload: { requestId, shares, error },
        })
      }
    })
  }

  async function handleKeyRestore(
    restoreReq: KeyRestoreMessage['payload'],
  ): Promise<void> {
    const vault = await readVault()
    if (!vault) {
      sendKeyRestoreResponse(restoreReq.requestId, 'Vault is locked')
      return
    }

    try {
      const shareA = {
        data: fromBase64Url(restoreReq.shareA.data),
        index: restoreReq.shareA.index,
      }
      const shareB = {
        data: fromBase64Url(restoreReq.shareB.data),
        index: restoreReq.shareB.index,
      }

      // Reconstruct the private key bytes
      const keyBytes = combine2of3(shareA, shareB)
      const keyJson = new TextDecoder().decode(keyBytes)
      const privateKeyJwk = JSON.parse(keyJson) as JsonWebKey

      // Validate it's a valid P-256 private key
      if (privateKeyJwk.kty !== 'EC' || privateKeyJwk.crv !== 'P-256' || !privateKeyJwk.d) {
        sendKeyRestoreResponse(restoreReq.requestId, 'Reconstructed key is not a valid P-256 private key')
        return
      }

      // Write restored key to vault
      vault.privateKeyJwk = privateKeyJwk

      // Regenerate did:jwk from the restored key
      const publicJwk: JsonWebKey = {
        kty: privateKeyJwk.kty,
        crv: privateKeyJwk.crv,
        x: privateKeyJwk.x,
        y: privateKeyJwk.y,
      }
      vault.did = publicJwkToDid(publicJwk)

      await writeVault(vault)
      sendKeyRestoreResponse(restoreReq.requestId, null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Key restoration failed'
      sendKeyRestoreResponse(restoreReq.requestId, msg)
    }
  }

  function sendKeyRestoreResponse(
    requestId: string,
    error: string | null,
  ): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'KEY_RESTORE_RESPONSE',
          payload: { requestId, success: error === null, error },
        })
      }
    })
  }

  // ── Helpers ──────────────────────────────────────────

  function sendReshareError(requestId: string, error: string): void {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'RESHARE_STORED_VP_RESPONSE',
          payload: { requestId, error },
        })
      }
    })
  }

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

      case 'SIGN_REQUEST':
        signPayload(message.payload).then((result) => {
          sendResponse(result)
        })
        break

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
        const didcommMsg = (message as DIDCommInboundMessage).payload
        const parsed = parseProofRequest(didcommMsg)

        if (parsed) {
          // Convert DIDComm proof request to our internal format
          // The popup will handle matching to a credential
          chrome.notifications.create(`didcomm-${parsed.id}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon/48.png'),
            title: 'DIDComm Proof Request',
            message: `${parsed.from} is requesting identity verification via DIDComm v2.`,
            buttons: [{ title: 'Review' }, { title: 'Dismiss' }],
            requireInteraction: true,
          })

          // Forward to popup
          chrome.runtime.sendMessage({
            type: 'DIDCOMM_PROOF_REQUEST',
            payload: parsed,
          })
        }
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

          // Send back to content script → page
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
                type: 'LIST_STORED_CREDENTIALS_RESPONSE',
                payload: { requestId: listReqId, credentials: creds },
              })
            }
          })
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

        readVault().then(async (vault) => {
          if (!vault) {
            sendReshareError(resharePayload.requestId, 'Vault locked')
            sendResponse({ ok: false })
            return
          }

          const cred = (vault.credentials ?? []).find(
            (c: StoredCredential) => c.id === resharePayload.credentialId,
          )
          if (!cred) {
            sendReshareError(resharePayload.requestId, 'Credential not found')
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

          // Return the raw credential + filtered claims for platform to wrap in a VP
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
              chrome.tabs.sendMessage(tabs[0].id, {
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
            }
          })
          sendResponse({ ok: true })
        })
        break
      }

      case 'DID_SYNC': {
        const syncReq = message.payload as DidSyncMessage['payload']
        handleDidSync(syncReq).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      case 'KEY_ROTATE': {
        const rotateReq = message.payload as KeyRotateMessage['payload']
        handleKeyRotate(rotateReq).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      case 'KEY_BACKUP': {
        const backupReq = message.payload as KeyBackupMessage['payload']
        handleKeyBackup(backupReq).then(() => {
          sendResponse({ ok: true })
        })
        break
      }

      case 'KEY_RESTORE': {
        const restoreReq = message.payload as KeyRestoreMessage['payload']
        handleKeyRestore(restoreReq).then(() => {
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

        readVault().then(async (vault) => {
          if (!vault || !vault.privateKeyJwk) {
            sendSigningErrorToTab(pendingSigning.senderTabId, pendingSigning.signReq.requestId, 'Vault not ready')
            sendResponse({ ok: false, error: 'Vault not ready' })
            return
          }

          const holderDid = selectedSignDid || vault.holderDid || vault.did

          if (!holderDid) {
            sendSigningErrorToTab(pendingSigning.senderTabId, pendingSigning.signReq.requestId, 'No DID configured')
            sendResponse({ ok: false, error: 'No DID configured' })
            return
          }

          try {
            const timestamp = String(Date.now())
            // Canonical signing payload (must match backend verification)
            const canonicalPayload = `attestto:sign:${pendingSigning.signReq.signingToken}:${holderDid}:${timestamp}`

            const privateKey = await crypto.subtle.importKey(
              'jwk',
              vault.privateKeyJwk,
              { name: 'ECDSA', namedCurve: 'P-256' },
              false,
              ['sign'],
            )

            const data = new TextEncoder().encode(canonicalPayload)
            const signatureBuffer = await crypto.subtle.sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              privateKey,
              data,
            )

            const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))

            const jwk = vault.privateKeyJwk as Record<string, string>
            const responseData = {
              did: holderDid,
              signature,
              timestamp,
              publicKeyJwk: {
                kty: jwk.kty || 'EC',
                crv: jwk.crv || 'P-256',
                x: jwk.x,
                y: jwk.y,
              },
            }

            sendSigningResponseToTab(pendingSigning.senderTabId, pendingSigning.signReq.requestId, responseData)
            sendResponse({ ok: true, ...responseData })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Signing failed'
            sendSigningErrorToTab(pendingSigning.senderTabId, pendingSigning.signReq.requestId, errMsg)
            sendResponse({ ok: false, error: errMsg })
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

        readVault().then(async (vault) => {
          if (!vault || !vault.privateKeyJwk) {
            sendAuthErrorToTab(pendingAuthReq.senderTabId, pendingAuthReq.requestId, 'Vault not ready')
            sendResponse({ ok: false, error: 'Vault not ready' })
            return
          }

          const holderDid = selectedAuthDid || vault.holderDid || vault.did

          if (!holderDid) {
            sendAuthErrorToTab(pendingAuthReq.senderTabId, pendingAuthReq.requestId, 'No identity configured')
            sendResponse({ ok: false, error: 'No identity configured' })
            return
          }

          try {
            // Canonical auth payload — MUST match backend DidAuthController
            // exactly. The page may pass an explicit `audience`; if it doesn't,
            // we fall back to origin (matching CORTEX's `audience ?? origin`).
            //   ${nonce}|${audience||origin}|${origin}|${timestamp}
            const audience = pendingAuthReq.origin
            const canonicalPayload = `${pendingAuthReq.nonce}|${audience}|${pendingAuthReq.origin}|${pendingAuthReq.timestamp}`

            const privateKey = await crypto.subtle.importKey(
              'jwk',
              vault.privateKeyJwk,
              { name: 'ECDSA', namedCurve: 'P-256' },
              false,
              ['sign'],
            )

            const data = new TextEncoder().encode(canonicalPayload)
            const signatureBuffer = await crypto.subtle.sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              privateKey,
              data,
            )

            const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))

            // Surface the public-key half of the vault JWK so the backend can
            // verify the signature even when no user_extension_keys row exists
            // yet (TOFU flow / fresh integrations).
            const jwk = vault.privateKeyJwk as Record<string, string>
            const responseData = {
              did: holderDid,
              signature,
              nonce: pendingAuthReq.nonce,
              timestamp: pendingAuthReq.timestamp,
              publicKeyJwk: {
                kty: jwk.kty || 'EC',
                crv: jwk.crv || 'P-256',
                x: jwk.x,
                y: jwk.y,
              },
            }
            sendAuthResponseToTab(pendingAuthReq.senderTabId, pendingAuthReq.requestId, responseData)
            sendResponse({ ok: true, ...responseData })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Auth signing failed'
            sendAuthErrorToTab(pendingAuthReq.senderTabId, pendingAuthReq.requestId, errMsg)
            sendResponse({ ok: false, error: errMsg })
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
          sendAuthErrorToTab(pendingAuthDeny.senderTabId, pendingAuthDeny.requestId, 'User declined')
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

        ;(async () => {
          try {
            const vault = await readVault()
            if (!vault) {
              sendAttesttoPdfErrorToTab(pendingApdf.senderTabId, pendingApdf.req.requestId, 'Vault not ready')
              sendResponse({ ok: false, error: 'Vault not ready' })
              return
            }

            const ed = await getOrCreateEd25519Key()
            if (!ed) {
              sendAttesttoPdfErrorToTab(pendingApdf.senderTabId, pendingApdf.req.requestId, 'Could not load Ed25519 key')
              sendResponse({ ok: false, error: 'Could not load Ed25519 key' })
              return
            }

            // Decode the canonical payload bytes the page sent. The
            // background does NOT inspect or re-canonicalize them —
            // the verify-side composable is the single source of
            // truth for the canonical shape (lockstep contract).
            const payloadBytes = Uint8Array.from(atob(pendingApdf.req.payloadB64), (c) => c.charCodeAt(0))

            const sigBuf = await crypto.subtle.sign(
              { name: 'Ed25519' },
              ed.privateKey,
              payloadBytes as BufferSource,
            )
            const sigBytes = new Uint8Array(sigBuf)
            if (sigBytes.length !== 64) {
              throw new Error(`Unexpected Ed25519 signature length: ${sigBytes.length}`)
            }
            const signatureB64 = btoa(String.fromCharCode(...sigBytes))

            // Issuer DID — honestly labels what this key actually is.
            // Not a fake did:key. The verifier doesn't resolve DIDs;
            // it uses the embedded raw publicKey for verification.
            const holderDid = selectedApdfDid
              || vault.holderDid
              || `did:key-vault:ed25519-${ed.publicKeyB64.slice(0, 12)}`

            const responseData = {
              did: holderDid,
              signature: signatureB64,
              publicKey: ed.publicKeyB64,
            }

            sendAttesttoPdfResponseToTab(pendingApdf.senderTabId, pendingApdf.req.requestId, responseData)
            sendResponse({ ok: true, ...responseData })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Attestto PDF signing failed'
            sendAttesttoPdfErrorToTab(pendingApdf.senderTabId, pendingApdf.req.requestId, errMsg)
            sendResponse({ ok: false, error: errMsg })
          }
        })()
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

        readVault().then(async (vault) => {
          if (!vault || !vault.privateKeyJwk) {
            sendPaymentErrorToTab(pendingPayment.senderTabId, pendingPayment.payReq.requestId, 'Vault not ready')
            sendResponse({ ok: false, error: 'Vault not ready' })
            return
          }

          const holderDid = selectedDid
            || vault.holderDid
            || vault.did

          if (!holderDid) {
            sendPaymentErrorToTab(pendingPayment.senderTabId, pendingPayment.payReq.requestId, 'No DID configured')
            sendResponse({ ok: false, error: 'No DID configured' })
            return
          }

          try {
            // Build canonical payment payload (must match backend DidPaymentResolver.buildPaymentPayload)
            const canonicalPayload = `attestto:pay:${pendingPayment.payReq.paymentRequestUuid}:${holderDid}:${pendingPayment.payReq.amount.toFixed(2)}`

            // Sign with vault's P-256 private key
            const privateKey = await crypto.subtle.importKey(
              'jwk',
              vault.privateKeyJwk,
              { name: 'ECDSA', namedCurve: 'P-256' },
              false,
              ['sign'],
            )

            const data = new TextEncoder().encode(canonicalPayload)
            const signatureBuffer = await crypto.subtle.sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              privateKey,
              data,
            )

            const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))

            // Public key components are already in the JWK (x, y)
            const jwk = vault.privateKeyJwk as Record<string, string>
            const responseData = {
              did: holderDid,
              signature,
              publicKeyJwk: {
                kty: jwk.kty || 'EC',
                crv: jwk.crv || 'P-256',
                x: jwk.x,
                y: jwk.y,
              },
            }

            sendPaymentResponseToTab(pendingPayment.senderTabId, pendingPayment.payReq.requestId, responseData)
            sendResponse({ ok: true, ...responseData })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Signing failed'
            sendPaymentErrorToTab(pendingPayment.senderTabId, pendingPayment.payReq.requestId, errMsg)
            sendResponse({ ok: false, error: errMsg })
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

        readVault().then(async (vault) => {
          if (!vault || !vault.privateKeyJwk) {
            sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, 'Vault not ready')
            sendResponse({ ok: false, error: 'Vault not ready' })
            return
          }

          const holderDid = vault.holderDid
            ?? vault.did
            ?? (vault.linkedSolanaAddress
              ? `did:pkh:solana:${vault.linkedSolanaAddress}`
              : null)

          if (!holderDid) {
            sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, 'No DID configured')
            sendResponse({ ok: false, error: 'No DID configured' })
            return
          }

          const credentials = (vault.credentials ?? []) as StoredCredential[]
          const vcs = credentials
            .filter((c) => c.format === 'json-ld')
            .map((c) => JSON.parse(c.raw) as Record<string, unknown>)

          const challenge = pending.apiReq.challenge ?? pending.apiReq.nonce ?? ''
          const domain = pending.apiReq.domain ?? pending.apiReq.origin ?? ''

          try {
            const vp = await createChapiVp({
              credentials: vcs,
              holderDid,
              holderPrivateKey: vault.privateKeyJwk,
              challenge,
              domain,
              verificationMethod: vault.verificationMethod,
            })

            // Send VP back to the original requesting tab (not the popup)
            if (pending.senderTabId) {
              chrome.tabs.sendMessage(pending.senderTabId, {
                type: 'CREDENTIAL_API_RESPONSE',
                payload: { requestId: pending.apiReq.requestId, presentation: vp },
              })
            }
            sendResponse({ ok: true, holderDid })
          } catch {
            sendChapiErrorToTab(pending.senderTabId, pending.apiReq.requestId, 'Failed to build presentation')
            sendResponse({ ok: false, error: 'VP build failed' })
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
    }

    return true
  })

  // ── Lifecycle ──────────────────────────────────────

  chrome.runtime.onStartup.addListener(() => {
    ensureOffscreenDocument()
  })

  chrome.runtime.onInstalled.addListener(() => {
    ensureOffscreenDocument()
  })
})
