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
import type { StoredCredential, ProofAccessRequest, PreparedPresentation } from '@/types/credential'
import { publicJwkToDid, didJwkVerificationMethod } from '@/utils/did-jwk'
import type { CredentialOfferMessage, PushPresentationMessage, ProofAccessRequestMessage, CredentialApiRequestMessage, DIDCommInboundMessage, DidSyncMessage, KeyRotateMessage, KeyBackupMessage, KeyRestoreMessage, PaymentRequestMessage, SignDocumentRequestMessage } from '@/utils/messaging'
import { split2of3, combine2of3, toBase64Url, fromBase64Url } from '@/services/shamir'

export default defineBackground(() => {
  // ── Offscreen Document Management ──────────────────

  const OFFSCREEN_PATH = 'offscreen.html'

  async function ensureOffscreenDocument(): Promise<void> {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    })

    if (existingContexts.length > 0) return

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS' as chrome.offscreen.Reason],
      justification: 'Maintain WebSocket connection for real-time wallet notifications',
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

  // Set up auto-lock alarm from stored preference
  async function resetAutoLockAlarm(): Promise<void> {
    const stored = await chrome.storage.local.get('attestto_ext_auto_lock_minutes')
    const minutes = Number(stored.attestto_ext_auto_lock_minutes) || 5
    chrome.alarms.create('autoLock', { delayInMinutes: minutes })
  }

  resetAutoLockAlarm()

  // ── Pending Credential Offers ─────────────────────

  const pendingOffers = new Map<string, CredentialOfferMessage['payload']>()

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
  }
  const pendingChapiRawRequests = new Map<string, PendingChapiRawRequest>()

  /** Pending payment requests waiting for user approval in the popup */
  interface PendingPaymentRequest {
    payReq: PaymentRequestMessage['payload']
    senderTabId: number | null
  }
  const pendingPaymentRequests = new Map<string, PendingPaymentRequest>()

  /** Pending document signing requests waiting for user approval in the popup */
  interface PendingSigningRequest {
    signReq: SignDocumentRequestMessage['payload']
    senderTabId: number | null
  }
  const pendingSigningRequests = new Map<string, PendingSigningRequest>()

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
      await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 580,
        focused: true,
      })
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
      await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 580,
        focused: true,
      })
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
    const offer = pendingOffers.get(notificationId)
    if (!offer) return null
    pendingOffers.delete(notificationId)

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

      // Store in public vault (always works, no passkey needed)
      const pub = await readPublicVault()
      if (pub) {
        pub.credentials = [...(pub.credentials ?? []), credential]
        await writePublicVault(pub)
      }

      // Also store in encrypted vault if unlocked
      const vault = await readVault()
      if (vault) {
        vault.credentials = [...(vault.credentials ?? []), credential]
        await writeVault(vault)
      }

      return credential.id
    } catch {
      return null
    }
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
      await chrome.windows.create({
        url: approvalUrl,
        type: 'popup',
        width: 380,
        height: 520,
        focused: true,
      })
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

      case 'SIGN_REQUEST':
        signPayload(message.payload).then((result) => {
          sendResponse(result)
        })
        break

      case 'CREDENTIAL_OFFER': {
        console.log('[Attestto ID] CREDENTIAL_OFFER received in background', message.payload)
        const offer = message.payload as CredentialOfferMessage['payload']
        const notifId = `credential-offer-${Date.now()}`
        pendingOffers.set(notifId, offer)

        chrome.notifications.create(notifId, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/48.png'),
          title: 'New Credential',
          message: `${offer.issuerName} wants to issue a ${offer.format.toUpperCase()} credential.`,
          buttons: [{ title: 'Accept' }, { title: 'Reject' }],
          requireInteraction: true,
        }, (createdId) => {
          if (chrome.runtime.lastError) {
            console.error('[Attestto ID] Notification creation failed:', chrome.runtime.lastError.message)
          } else {
            console.log('[Attestto ID] Notification created:', createdId)
          }
        })

        sendResponse({ ok: true })
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
          handleChapiRequest(apiReq, _sender.tab?.id ?? null).then(() => {
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
        handleSigningRequest(signReq, _sender.tab?.id ?? null).then(() => {
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
          pendingSigningRequests.delete(signDenyId)
          sendSigningErrorToTab(pendingSignDeny.senderTabId, pendingSignDeny.signReq.requestId, 'User declined signing')
        }
        sendResponse({ ok: true })
        break
      }

      // ── Payment Request Handler ──

      case 'PAYMENT_REQUEST': {
        const payReq = message.payload as PaymentRequestMessage['payload']
        handlePaymentRequest(payReq, _sender.tab?.id ?? null).then(() => {
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
