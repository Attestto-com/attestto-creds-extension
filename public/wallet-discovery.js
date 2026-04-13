/**
 * Wallet Discovery Handler — injected into page MAIN world via <script src>.
 *
 * Responds to the credential-wallet:discover protocol (identity-bridge)
 * and overrides navigator.credentials.get for CHAPI interception.
 *
 * This is a web-accessible resource loaded via script.src (not inline),
 * so it works even on pages with strict CSP.
 */
(function () {
  'use strict'

  // -----------------------------------------------------------------
  // Credential Wallet Discovery Protocol (identity-bridge compatible)
  // -----------------------------------------------------------------

  var ATTESTTO_WALLET = {
    did: 'did:web:attestto.com:wallets:attestto-creds',
    name: 'Attestto Creds',
    icon: 'https://attestto.com/icons/attestto-creds-64.svg',
    version: '0.1.0',
    protocols: ['chapi', 'didcomm-v2'],
    maintainer: {
      name: 'Attestto',
      did: 'did:web:attestto.com',
      url: 'https://attestto.com',
    },
    url: 'https://github.com/Attestto-com/attestto-creds-extension',
  }

  window.addEventListener('credential-wallet:discover', function (e) {
    var nonce = e.detail && e.detail.nonce
    if (!nonce) return
    console.log('[Attestto Creds] Discovery request received, nonce:', nonce)
    window.dispatchEvent(
      new CustomEvent('credential-wallet:announce', {
        detail: { nonce: nonce, wallet: ATTESTTO_WALLET },
      })
    )
  })

  // -----------------------------------------------------------------
  // Override navigator.credentials.get for CHAPI + Attestto VP
  // -----------------------------------------------------------------

  if (navigator.credentials && navigator.credentials.get) {
    var originalGet = navigator.credentials.get.bind(navigator.credentials)

    navigator.credentials.get = function (options) {
      // Path 1: W3C CHAPI — { web: { VerifiablePresentation } }
      var chapiVP =
        options && options.web && options.web.VerifiablePresentation
      if (chapiVP) {
        return new Promise(function (resolve, reject) {
          var requestId =
            'attestto-chapi-' +
            Date.now() +
            '-' +
            Math.random().toString(36).slice(2)

          function handleResponse(event) {
            if (event.source !== window) return
            if (!event.data || event.data.type !== 'ATTESTTO_VP_RESPONSE')
              return
            if (event.data.requestId !== requestId) return
            window.removeEventListener('message', handleResponse)

            if (event.data.error) {
              reject(new DOMException(event.data.error, 'NotAllowedError'))
            } else {
              resolve({
                type: 'web',
                dataType: 'VerifiablePresentation',
                data: event.data.presentation,
              })
            }
          }

          window.addEventListener('message', handleResponse)

          window.postMessage(
            {
              type: 'ATTESTTO_VP_REQUEST',
              requestId: requestId,
              payload: {
                protocol: 'chapi',
                queryType:
                  (chapiVP.query && chapiVP.query.type) ||
                  'DIDAuthentication',
                challenge: chapiVP.challenge || null,
                domain: chapiVP.domain || window.location.origin,
                requestedFields: [],
                audience: chapiVP.domain || window.location.origin,
                credentialType: 'VerifiablePresentation',
              },
            },
            '*'
          )

          setTimeout(function () {
            window.removeEventListener('message', handleResponse)
            reject(
              new DOMException(
                'User did not respond in time',
                'NotAllowedError'
              )
            )
          }, 300000)
        })
      }

      // Path 2: Attestto proprietary
      var extensions =
        options && options.publicKey && options.publicKey.extensions
      var identity = options && options.identity
      var vpRequest =
        (extensions && extensions.attesttoVP) ||
        (identity && identity.attesttoVP)

      if (!vpRequest) {
        return originalGet(options)
      }

      return new Promise(function (resolve, reject) {
        var requestId =
          'attestto-vp-' +
          Date.now() +
          '-' +
          Math.random().toString(36).slice(2)

        function handleResponse(event) {
          if (event.source !== window) return
          if (!event.data || event.data.type !== 'ATTESTTO_VP_RESPONSE')
            return
          if (event.data.requestId !== requestId) return
          window.removeEventListener('message', handleResponse)

          if (event.data.error) {
            reject(new DOMException(event.data.error, 'NotAllowedError'))
          } else {
            resolve(event.data.presentation)
          }
        }

        window.addEventListener('message', handleResponse)

        window.postMessage(
          {
            type: 'ATTESTTO_VP_REQUEST',
            requestId: requestId,
            payload: {
              protocol: 'attestto',
              nonce: vpRequest.nonce,
              requestedFields: vpRequest.requestedFields || [],
              audience: vpRequest.audience || window.location.origin,
              credentialType:
                vpRequest.credentialType || 'VerifiableCredential',
            },
          },
          '*'
        )

        setTimeout(function () {
          window.removeEventListener('message', handleResponse)
          reject(
            new DOMException(
              'User did not respond in time',
              'NotAllowedError'
            )
          )
        }, 300000)
      })
    }
  }

  // Signal readiness
  window.dispatchEvent(
    new CustomEvent('attestto-creds-ready', {
      detail: { version: '0.1.0', protocols: ['chapi', 'didcomm-v2'] },
    })
  )

  console.log('[Attestto Creds] Wallet discovery handler loaded')
})()
