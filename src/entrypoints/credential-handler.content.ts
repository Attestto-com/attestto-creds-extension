/**
 * MAIN world content script — Credential Handler + Wallet Discovery.
 *
 * Runs in the page's MAIN world so it can:
 *  1. Respond to credential-wallet:discover events (identity-bridge protocol)
 *  2. Override navigator.credentials.get() for CHAPI interception
 */

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    console.log('[Attestto ID] MAIN world script loaded')

    // -----------------------------------------------------------------
    // Credential Wallet Discovery Protocol (identity-bridge compatible)
    // -----------------------------------------------------------------

    // Read the extension icon URL shared by the ISOLATED content script
    const extensionIcon = document.documentElement.getAttribute('data-attestto-id-icon')
      || 'https://attestto.com/icons/attestto-id-64.svg'

    const ATTESTTO_WALLET = {
      did: 'did:web:attestto.com:wallets:attestto-creds',
      name: 'Attestto',
      icon: extensionIcon,
      version: '0.1.0',
      protocols: ['chapi' as const, 'didcomm-v2' as const],
      maintainer: {
        name: 'Attestto',
        did: 'did:web:attestto.com',
        url: 'https://attestto.com',
      },
      url: 'https://github.com/Attestto-com/attestto-id-extension',
    }

    window.addEventListener('credential-wallet:discover', (e: Event) => {
      const detail = (e as CustomEvent<{ nonce: string }>).detail
      if (!detail?.nonce) return
      console.log('[Attestto ID] Discovery request, nonce:', detail.nonce)
      window.dispatchEvent(
        new CustomEvent('credential-wallet:announce', {
          detail: { nonce: detail.nonce, wallet: ATTESTTO_WALLET },
        }),
      )
    })

    // -----------------------------------------------------------------
    // DID Authentication (SOC-71) — credential-wallet:auth
    // -----------------------------------------------------------------
    // A verifying site (via @attestto/id-wallet-adapter `requestAuth`) dispatches
    // `credential-wallet:auth`; the wallet signs the challenge and replies with
    // `credential-wallet:auth-response`, which the adapter's `verifyAuth` checks.
    //
    // MAIN world can't reach the background, so we relay through the ISOLATED
    // content script via postMessage. The envelope `nonce` correlates the
    // request → response event; the inner `request.nonce` is what gets signed.

    window.addEventListener('credential-wallet:auth', (e: Event) => {
      const detail = (e as CustomEvent<{
        nonce: string
        walletDid?: string
        request?: { nonce?: string; audience?: string; origin?: string; trustedIssuers?: string[] }
      }>).detail

      const envelopeNonce = detail?.nonce
      const request = detail?.request
      if (!envelopeNonce || !request?.nonce) return

      // Only answer auth aimed at this wallet (the adapter passes the discovered
      // wallet DID). Ignore requests targeted at a different wallet.
      if (detail.walletDid && detail.walletDid !== ATTESTTO_WALLET.did) return

      function dispatchAuthResponse(response: unknown) {
        window.dispatchEvent(
          new CustomEvent('credential-wallet:auth-response', {
            detail: { nonce: envelopeNonce, response },
          }),
        )
      }

      function handleResponse(event: MessageEvent) {
        if (event.source !== window) return
        if (event.data?.type !== 'ATTESTTO_CW_AUTH_RESPONSE') return
        if (event.data?.requestId !== envelopeNonce) return
        window.removeEventListener('message', handleResponse)

        if (event.data.error || !event.data.response) {
          // Resolve the site's requestAuth with an unapproved response rather
          // than letting it hang until its timeout; verifyAuth then rejects it.
          dispatchAuthResponse({ approved: false })
        } else {
          dispatchAuthResponse(event.data.response)
        }
      }

      window.addEventListener('message', handleResponse)

      window.postMessage({
        type: 'ATTESTTO_CW_AUTH_REQUEST',
        requestId: envelopeNonce,
        nonce: request.nonce,
        audience: request.audience || window.location.origin,
        trustedIssuers: request.trustedIssuers,
      }, window.location.origin)

      // Safety timeout mirrors the adapter's default requestAuth window.
      setTimeout(() => {
        window.removeEventListener('message', handleResponse)
      }, 120000)
    })

    // -----------------------------------------------------------------
    // Override navigator.credentials.get for CHAPI + Attestto VP
    // -----------------------------------------------------------------

    try {
      const originalGet = navigator.credentials?.get?.bind(navigator.credentials)
      if (!originalGet) {
        console.warn('[Attestto ID] navigator.credentials.get not available')
        return
      }

      navigator.credentials.get = async function (
        options?: CredentialRequestOptions,
      ): Promise<Credential | null> {
        const opts = options as Record<string, unknown> | undefined

        // Path 1: W3C CHAPI — { web: { VerifiablePresentation } }
        const web = opts?.web as Record<string, unknown> | undefined
        const chapiVP = web?.VerifiablePresentation as Record<string, unknown> | undefined

        if (chapiVP) {
          return new Promise((resolve, reject) => {
            const requestId = 'attestto-chapi-' + Date.now() + '-' + Math.random().toString(36).slice(2)

            function handleResponse(event: MessageEvent) {
              if (event.source !== window) return
              if (event.data?.type !== 'ATTESTTO_VP_RESPONSE') return
              if (event.data?.requestId !== requestId) return
              window.removeEventListener('message', handleResponse)

              if (event.data.error) {
                reject(new DOMException(event.data.error, 'NotAllowedError'))
              } else {
                resolve({
                  type: 'web',
                  dataType: 'VerifiablePresentation',
                  data: event.data.presentation,
                } as unknown as Credential)
              }
            }

            window.addEventListener('message', handleResponse)

            window.postMessage({
              type: 'ATTESTTO_VP_REQUEST',
              requestId,
              payload: {
                protocol: 'chapi',
                queryType: (chapiVP.query as Record<string, unknown>)?.type || 'DIDAuthentication',
                challenge: chapiVP.challenge || null,
                domain: chapiVP.domain || window.location.origin,
                requestedFields: [],
                audience: chapiVP.domain || window.location.origin,
                credentialType: 'VerifiablePresentation',
              },
            }, window.location.origin)

            setTimeout(() => {
              window.removeEventListener('message', handleResponse)
              reject(new DOMException('User did not respond in time', 'NotAllowedError'))
            }, 300000)
          })
        }

        // Path 2: Attestto proprietary — { publicKey.extensions.attesttoVP }
        const publicKey = opts?.publicKey as Record<string, unknown> | undefined
        const identity = opts?.identity as Record<string, unknown> | undefined
        const extensions = publicKey?.extensions as Record<string, unknown> | undefined
        const vpRequest = (extensions?.attesttoVP || identity?.attesttoVP) as Record<string, unknown> | undefined

        if (!vpRequest) {
          return originalGet(options)
        }

        return new Promise((resolve, reject) => {
          const requestId = 'attestto-vp-' + Date.now() + '-' + Math.random().toString(36).slice(2)

          function handleResponse(event: MessageEvent) {
            if (event.source !== window) return
            if (event.data?.type !== 'ATTESTTO_VP_RESPONSE') return
            if (event.data?.requestId !== requestId) return
            window.removeEventListener('message', handleResponse)

            if (event.data.error) {
              reject(new DOMException(event.data.error, 'NotAllowedError'))
            } else {
              resolve(event.data.presentation)
            }
          }

          window.addEventListener('message', handleResponse)

          window.postMessage({
            type: 'ATTESTTO_VP_REQUEST',
            requestId,
            payload: {
              protocol: 'attestto',
              nonce: vpRequest.nonce,
              requestedFields: (vpRequest.requestedFields as string[]) || [],
              audience: (vpRequest.audience as string) || window.location.origin,
              credentialType: (vpRequest.credentialType as string) || 'VerifiableCredential',
            },
          }, window.location.origin)

          setTimeout(() => {
            window.removeEventListener('message', handleResponse)
            reject(new DOMException('User did not respond in time', 'NotAllowedError'))
          }, 300000)
        })
      }
    } catch (err) {
      console.warn('[Attestto ID] Could not override navigator.credentials.get:', err)
    }

    // Signal readiness
    window.dispatchEvent(
      new CustomEvent('attestto-id-ready', {
        detail: { version: '0.1.0', protocols: ['chapi', 'didcomm-v2'] },
      }),
    )
  },
})
