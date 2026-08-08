/**
 * Content Script — W3C Credential Management API bridge.
 *
 * Runs on all HTTPS pages. Injects the credential handler into the
 * page's MAIN world and bridges messages between page ↔ extension.
 *
 * Flow:
 *   Page calls navigator.credentials.get({ ... attesttoVP: { ... } })
 *   → MAIN world script posts ATTESTTO_VP_REQUEST to window
 *   → This content script receives it
 *   → Forwards to background via chrome.runtime.sendMessage
 *   → Background triggers consent popup
 *   → User approves → background returns presentation
 *   → This content script posts ATTESTTO_VP_RESPONSE back to page
 */

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  runAt: 'document_start',
  world: 'ISOLATED',

  main() {
    console.log('[Attestto ID] Content script loaded on', window.location.href)

    // Mark the page so any site can detect Attestto Creds is installed.
    // `data-attestto-creds` is the documented detection signal (per README + CORTEX page check).
    // `data-attestto-id` is the legacy attribute kept for backwards compatibility — remove next release.
    document.documentElement.setAttribute('data-attestto-creds', 'true')
    document.documentElement.setAttribute('data-attestto-id', 'true')

    // Share the extension icon URL with the MAIN world (for wallet discovery)
    document.documentElement.setAttribute(
      'data-attestto-creds-icon',
      chrome.runtime.getURL('icon/48.png'),
    )
    document.documentElement.setAttribute(
      'data-attestto-id-icon',
      chrome.runtime.getURL('icon/48.png'),
    )

    // MAIN world handler (credential-handler.content.ts) handles:
    //  - Wallet discovery protocol (identity-bridge CustomEvents)
    //  - navigator.credentials.get() override (CHAPI)

    // Bridge: page → extension
    window.addEventListener('message', (event) => {
      if (event.source !== window) return

      const { type: msgType } = event.data ?? {}

      // VP request (CHAPI standard + Attestto proprietary)
      if (msgType === 'ATTESTTO_VP_REQUEST') {
        const { requestId, payload } = event.data

        chrome.runtime.sendMessage(
          {
            type: 'CREDENTIAL_API_REQUEST',
            payload: {
              requestId,
              protocol: payload.protocol || 'attestto',
              // CHAPI fields
              challenge: payload.challenge || null,
              domain: payload.domain || null,
              queryType: payload.queryType || null,
              credentialType: payload.credentialType || null,
              // Attestto proprietary fields
              nonce: payload.nonce,
              requestedFields: payload.requestedFields,
              audience: payload.audience,
              origin: window.location.origin,
            },
          },
          (_response) => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_VP_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // List stored credentials (dashboard → extension)
      if (msgType === 'ATTESTTO_LIST_CREDENTIALS') {
        const { requestId } = event.data
        chrome.runtime.sendMessage(
          { type: 'LIST_STORED_CREDENTIALS', payload: { requestId, origin: window.location.origin } },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_LIST_CREDENTIALS_RESPONSE',
                requestId,
                error: 'Extension not available',
                credentials: [],
              }, window.location.origin)
            }
          },
        )
        return
      }

      // DID Sync — platform pushes holderDid + verificationMethod to extension
      if (msgType === 'ATTESTTO_DID_SYNC') {
        const { requestId, holderDid, verificationMethod } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'DID_SYNC',
            payload: { requestId, holderDid, verificationMethod, origin: window.location.origin },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_DID_SYNC_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // Key rotation / backup / restore are intentionally NOT bridged from web
      // pages. These operations mutate or export the vault signing key and are
      // Options-UI-only (SOC-2 / SOC-3 / SOC-8). A page posting
      // ATTESTTO_KEY_ROTATE / _BACKUP / _RESTORE is ignored here and never
      // reaches the background service worker.

      // Payment Request — page asks extension to approve + sign a payment
      if (msgType === 'ATTESTTO_PAYMENT_REQUEST') {
        const { requestId, paymentRequestUuid, amount, currency, merchantName, description } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'PAYMENT_REQUEST',
            payload: {
              requestId,
              paymentRequestUuid,
              amount,
              currency: currency || 'USDC',
              merchantName,
              description: description || '',
              origin: window.location.origin,
            },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_PAYMENT_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // DID Authentication Request — login page asks extension to sign a proof-of-possession
      // (ATT-123 — restored on attestto-creds-extension after standalone-repo extraction dropped it)
      if (msgType === 'ATTESTTO_AUTH_REQUEST') {
        const { requestId, nonce, timestamp } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'AUTH_REQUEST',
            payload: {
              requestId,
              nonce,
              timestamp,
              origin: window.location.origin,
            },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_AUTH_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // credential-wallet:auth (SOC-71) — the MAIN-world identity bridge relays
      // the adapter's auth request here so the background can sign it. `origin`
      // is stamped from this content script (trusted), never taken from the page.
      if (msgType === 'ATTESTTO_CW_AUTH_REQUEST') {
        const { requestId, nonce, audience, trustedIssuers } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'CW_AUTH_REQUEST',
            payload: {
              requestId,
              nonce,
              audience,
              trustedIssuers,
              origin: window.location.origin,
            },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_CW_AUTH_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // Document Signing Request — page asks extension to DID-sign a document
      if (msgType === 'ATTESTTO_SIGN_REQUEST') {
        const { requestId, signingToken, documentTitle, signerName } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'SIGN_DOCUMENT_REQUEST',
            payload: {
              requestId,
              signingToken,
              documentTitle,
              signerName,
              origin: window.location.origin,
            },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_SIGN_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // Attestto self-attested PDF signing (ATT-364) — page sends raw
      // canonical payload bytes (base64), wallet signs with Ed25519,
      // returns 64-byte sig + 32-byte pubkey (both base64).
      if (msgType === 'ATTESTTO_SIGN_PDF_REQUEST') {
        const { requestId, payloadB64, fileName, documentHash } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'SIGN_ATTESTTO_PDF_REQUEST',
            payload: {
              requestId,
              payloadB64,
              fileName: fileName || 'document.pdf',
              documentHash: documentHash || '',
              origin: window.location.origin,
            },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_SIGN_PDF_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }

      // Push credential to extension vault (dashboard → extension)
      if (msgType === 'ATTESTTO_CREDENTIAL_PUSH') {
        const { requestId, credential } = event.data
        console.log('[Attestto ID] CREDENTIAL_PUSH received in content script', { requestId, credential })
        chrome.runtime.sendMessage(
          {
            type: 'CREDENTIAL_OFFER',
            payload: {
              requestId,
              format: credential.format || 'attestto-id',
              raw: credential.raw || '',
              issuerName: credential.issuer || 'Attestto Platform',
              claims: credential.claims || {},
              origin: window.location.origin,
            },
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Attestto ID] CREDENTIAL_PUSH → runtime error:', chrome.runtime.lastError.message)
              window.postMessage({
                type: 'ATTESTTO_CREDENTIAL_PUSH_RESPONSE',
                requestId,
                success: false,
                error: 'Extension not available',
              }, window.location.origin)
            } else {
              console.log('[Attestto ID] CREDENTIAL_PUSH → background responded:', response)
              window.postMessage({
                type: 'ATTESTTO_CREDENTIAL_PUSH_RESPONSE',
                requestId,
                success: !!response?.ok,
                error: response?.error,
              }, window.location.origin)
            }
          },
        )
        return
      }

      // Reshare a stored VP (dashboard → extension)
      if (msgType === 'ATTESTTO_RESHARE_VP') {
        const { requestId, credentialId, selectedFields } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'RESHARE_STORED_VP',
            payload: { requestId, credentialId, selectedFields, origin: window.location.origin },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_RESHARE_VP_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, window.location.origin)
            }
          },
        )
        return
      }
    })

    // Bridge: extension → page (responses)
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'CREDENTIAL_API_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_VP_RESPONSE',
          requestId: message.payload.requestId,
          presentation: message.payload.presentation,
          error: message.payload.error,
        }, window.location.origin)
      }

      if (message.type === 'LIST_STORED_CREDENTIALS_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_LIST_CREDENTIALS_RESPONSE',
          requestId: message.payload.requestId,
          credentials: message.payload.credentials,
          error: message.payload.error,
        }, window.location.origin)
      }

      if (message.type === 'RESHARE_STORED_VP_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_RESHARE_VP_RESPONSE',
          requestId: message.payload.requestId,
          presentation: message.payload.presentation,
          error: message.payload.error,
        }, window.location.origin)
      }

      if (message.type === 'DID_SYNC_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_DID_SYNC_RESPONSE',
          requestId: message.payload.requestId,
          publicKeyJwk: message.payload.publicKeyJwk,
          holderDid: message.payload.holderDid,
          error: message.payload.error,
        }, window.location.origin)
      }

      // No KEY_ROTATE / KEY_BACKUP / KEY_RESTORE response bridges: those ops are
      // Options-UI-only and never round-trip through a web page (SOC-2/3/8).

      if (message.type === 'AUTH_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_AUTH_RESPONSE',
          requestId: message.payload.requestId,
          did: message.payload.did,
          signature: message.payload.signature,
          nonce: message.payload.nonce,
          timestamp: message.payload.timestamp,
          publicKeyJwk: message.payload.publicKeyJwk,
          error: message.payload.error,
        }, window.location.origin)
      }

      // credential-wallet:auth-response (SOC-71) — carries the full AuthResponse
      // object back to the MAIN world, which dispatches the adapter's event.
      if (message.type === 'CW_AUTH_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_CW_AUTH_RESPONSE',
          requestId: message.payload.requestId,
          response: message.payload.response,
          error: message.payload.error,
        }, window.location.origin)
      }

      if (message.type === 'SIGN_DOCUMENT_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_SIGN_RESPONSE',
          requestId: message.payload.requestId,
          did: message.payload.did,
          signature: message.payload.signature,
          publicKeyJwk: message.payload.publicKeyJwk,
          timestamp: message.payload.timestamp,
          error: message.payload.error,
        }, window.location.origin)
      }

      if (message.type === 'SIGN_ATTESTTO_PDF_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_SIGN_PDF_RESPONSE',
          requestId: message.payload.requestId,
          did: message.payload.did,
          signature: message.payload.signature,
          publicKey: message.payload.publicKey,
          error: message.payload.error,
        }, window.location.origin)
      }

      if (message.type === 'PAYMENT_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_PAYMENT_RESPONSE',
          requestId: message.payload.requestId,
          did: message.payload.did,
          signature: message.payload.signature,
          publicKeyJwk: message.payload.publicKeyJwk,
          error: message.payload.error,
        }, window.location.origin)
      }
    })
  },
})
