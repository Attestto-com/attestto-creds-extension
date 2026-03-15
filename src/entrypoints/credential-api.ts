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

import { buildCredentialHandlerScript } from '@/services/credential-handler'

export default defineContentScript({
  matches: ['https://*/*'],
  runAt: 'document_start',
  world: 'ISOLATED',

  main() {
    // Mark the page so any site can detect Attestto Creds is installed
    document.documentElement.setAttribute('data-attestto-creds', 'true')

    // Inject the credential handler into the page's MAIN world
    const script = document.createElement('script')
    script.textContent = buildCredentialHandlerScript()
    ;(document.head || document.documentElement).appendChild(script)
    script.remove()

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
          (response) => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_VP_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, '*')
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
              }, '*')
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
              }, '*')
            }
          },
        )
        return
      }

      // Key Rotation — platform requests extension to generate a fresh keypair
      if (msgType === 'ATTESTTO_KEY_ROTATE') {
        const { requestId } = event.data
        chrome.runtime.sendMessage(
          {
            type: 'KEY_ROTATE',
            payload: { requestId, origin: window.location.origin },
          },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({
                type: 'ATTESTTO_KEY_ROTATE_RESPONSE',
                requestId,
                error: 'Extension not available',
              }, '*')
            }
          },
        )
        return
      }

      // Key Backup — extension splits private key into 2-of-3 shares
      if (msgType === 'ATTESTTO_KEY_BACKUP') {
        const { requestId } = event.data
        chrome.runtime.sendMessage(
          { type: 'KEY_BACKUP', payload: { requestId, origin: window.location.origin } },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({ type: 'ATTESTTO_KEY_BACKUP_RESPONSE', requestId, error: 'Extension not available' }, '*')
            }
          },
        )
        return
      }

      // Key Restore — extension reconstructs private key from 2 sub-shares
      if (msgType === 'ATTESTTO_KEY_RESTORE') {
        const { requestId, shareA, shareB } = event.data
        chrome.runtime.sendMessage(
          { type: 'KEY_RESTORE', payload: { requestId, shareA, shareB, origin: window.location.origin } },
          () => {
            if (chrome.runtime.lastError) {
              window.postMessage({ type: 'ATTESTTO_KEY_RESTORE_RESPONSE', requestId, error: 'Extension not available' }, '*')
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
              }, '*')
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
        }, '*')
      }

      if (message.type === 'LIST_STORED_CREDENTIALS_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_LIST_CREDENTIALS_RESPONSE',
          requestId: message.payload.requestId,
          credentials: message.payload.credentials,
          error: message.payload.error,
        }, '*')
      }

      if (message.type === 'RESHARE_STORED_VP_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_RESHARE_VP_RESPONSE',
          requestId: message.payload.requestId,
          presentation: message.payload.presentation,
          error: message.payload.error,
        }, '*')
      }

      if (message.type === 'DID_SYNC_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_DID_SYNC_RESPONSE',
          requestId: message.payload.requestId,
          publicKeyJwk: message.payload.publicKeyJwk,
          holderDid: message.payload.holderDid,
          error: message.payload.error,
        }, '*')
      }

      if (message.type === 'KEY_ROTATE_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_KEY_ROTATE_RESPONSE',
          requestId: message.payload.requestId,
          newPublicKeyJwk: message.payload.newPublicKeyJwk,
          oldPublicKeyJwk: message.payload.oldPublicKeyJwk,
          error: message.payload.error,
        }, '*')
      }

      if (message.type === 'KEY_BACKUP_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_KEY_BACKUP_RESPONSE',
          requestId: message.payload.requestId,
          shares: message.payload.shares,
          error: message.payload.error,
        }, '*')
      }

      if (message.type === 'KEY_RESTORE_RESPONSE') {
        window.postMessage({
          type: 'ATTESTTO_KEY_RESTORE_RESPONSE',
          requestId: message.payload.requestId,
          success: message.payload.success,
          error: message.payload.error,
        }, '*')
      }
    })
  },
})
