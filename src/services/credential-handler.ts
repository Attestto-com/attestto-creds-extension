/**
 * W3C Credential Management API — page-injectable handler.
 *
 * Intercepts `navigator.credentials.get()` calls from verifier websites
 * and routes them to the extension's background service worker via
 * `window.postMessage` → content script → `chrome.runtime.sendMessage`.
 *
 * Supports two interception paths:
 *  1. **W3C CHAPI standard** — `{ web: { VerifiablePresentation: { query, challenge, domain } } }`
 *     Any site using the Credential Handler API can request a VP from Attestto Creds.
 *  2. **Attestto proprietary** — `{ publicKey: { extensions: { attesttoVP } } }`
 *     Legacy Attestto platform integration with field-level selective disclosure.
 *
 * This script is injected into the page's MAIN world by the content script.
 */

/**
 * Build the injectable script that overrides navigator.credentials.get
 * in the page's main world.
 */
export function buildCredentialHandlerScript(): string {
  return `
(function() {
  'use strict';

  const originalGet = navigator.credentials.get.bind(navigator.credentials);

  navigator.credentials.get = async function(options) {
    // ---------------------------------------------------------------
    // Path 1: W3C CHAPI standard — { web: { VerifiablePresentation } }
    // Any site (DID Explorer, verifiers, etc.) can use this format.
    // ---------------------------------------------------------------
    const chapiVP = options?.web?.VerifiablePresentation;
    if (chapiVP) {
      return new Promise((resolve, reject) => {
        const requestId = 'attestto-chapi-' + Date.now() + '-' + Math.random().toString(36).slice(2);

        function handleResponse(event) {
          if (event.source !== window) return;
          if (event.data?.type !== 'ATTESTTO_VP_RESPONSE') return;
          if (event.data?.requestId !== requestId) return;
          window.removeEventListener('message', handleResponse);

          if (event.data.error) {
            reject(new DOMException(event.data.error, 'NotAllowedError'));
          } else {
            // Return a WebCredential-like object with the VP in .data
            resolve({ type: 'web', dataType: 'VerifiablePresentation', data: event.data.presentation });
          }
        }

        window.addEventListener('message', handleResponse);

        window.postMessage({
          type: 'ATTESTTO_VP_REQUEST',
          requestId: requestId,
          payload: {
            protocol: 'chapi',
            queryType: chapiVP.query?.type || 'DIDAuthentication',
            challenge: chapiVP.challenge || null,
            domain: chapiVP.domain || window.location.origin,
            requestedFields: [],
            audience: chapiVP.domain || window.location.origin,
            credentialType: 'VerifiablePresentation',
          },
        }, '*');

        setTimeout(() => {
          window.removeEventListener('message', handleResponse);
          reject(new DOMException('User did not respond in time', 'NotAllowedError'));
        }, 300000);
      });
    }

    // ---------------------------------------------------------------
    // Path 2: Attestto proprietary — { publicKey.extensions.attesttoVP }
    // Platform integration with field-level selective disclosure.
    // ---------------------------------------------------------------
    const publicKey = options?.publicKey;
    const identity = options?.identity;
    const extensions = publicKey?.extensions;
    const vpRequest = extensions?.attesttoVP || identity?.attesttoVP;

    if (!vpRequest) {
      // Not for us — pass through to the original handler (e.g. WebAuthn)
      return originalGet(options);
    }

    return new Promise((resolve, reject) => {
      const requestId = 'attestto-vp-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      function handleResponse(event) {
        if (event.source !== window) return;
        if (event.data?.type !== 'ATTESTTO_VP_RESPONSE') return;
        if (event.data?.requestId !== requestId) return;
        window.removeEventListener('message', handleResponse);

        if (event.data.error) {
          reject(new DOMException(event.data.error, 'NotAllowedError'));
        } else {
          resolve(event.data.presentation);
        }
      }

      window.addEventListener('message', handleResponse);

      window.postMessage({
        type: 'ATTESTTO_VP_REQUEST',
        requestId: requestId,
        payload: {
          protocol: 'attestto',
          nonce: vpRequest.nonce,
          requestedFields: vpRequest.requestedFields || [],
          audience: vpRequest.audience || window.location.origin,
          credentialType: vpRequest.credentialType || 'VerifiableCredential',
        },
      }, '*');

      setTimeout(() => {
        window.removeEventListener('message', handleResponse);
        reject(new DOMException('User did not respond in time', 'NotAllowedError'));
      }, 300000);
    });
  };

  // -------------------------------------------------------------------
  // Credential Wallet Discovery Protocol — respond to discover events
  // -------------------------------------------------------------------
  var ATTESTTO_DID_WALLET = {
    did: 'did:web:attestto.com:wallets:attestto-creds',
    name: 'Attestto Creds',
    icon: 'https://attestto.com/icons/attestto-creds-64.svg',
    version: '0.1.0',
    protocols: ['chapi', 'didcomm-v2'],
    maintainer: {
      name: 'Attestto',
      did: 'did:web:attestto.com',
      url: 'https://attestto.com'
    },
    url: 'https://github.com/Attestto-com/attestto-creds'
  };

  window.addEventListener('credential-wallet:discover', function(e) {
    var nonce = e.detail && e.detail.nonce;
    if (!nonce) return;
    window.dispatchEvent(new CustomEvent('credential-wallet:announce', {
      detail: { nonce: nonce, wallet: ATTESTTO_DID_WALLET }
    }));
  });

  // Legacy: signal readiness for backward compat
  window.dispatchEvent(new CustomEvent('attestto-creds-ready', {
    detail: { version: '0.1.0', protocols: ['chapi', 'didcomm-v2'] }
  }));
})();
  `.trim()
}
