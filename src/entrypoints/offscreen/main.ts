/**
 * Offscreen Document — hidden HTML page that keeps an SSE connection alive.
 *
 * MV3 Service Workers cannot maintain persistent connections because
 * Chrome kills them after ~30 s of inactivity. This offscreen document
 * is a standard JS context (not a SW) so it CAN hold an EventSource open.
 *
 * Flow:
 *   Server → SSE (AdonisJS Transmit) → offscreen/main.ts → chrome.runtime.sendMessage
 *   → background.ts (Service Worker) → chrome.notifications.create
 *
 * The SSE channel is `ssi/user_{userId}` and delivers credential_offer events
 * when the user pushes a credential from the Attestto dashboard to the extension.
 */

import { STORAGE_KEYS } from '@/config/app'

const API_BASE = 'https://api.attestto.com'
const RECONNECT_DELAY_MS = 5_000

let eventSource: EventSource | null = null

/**
 * Connect to the SSE channel for credential push events.
 * Reads the auth token and user ID from session storage.
 */
function connect(): void {
  chrome.storage.session.get(
    [STORAGE_KEYS.SESSION_KEY, 'attestto_user_id'],
    (result) => {
      const token = result[STORAGE_KEYS.SESSION_KEY] as string | undefined
      const userId = result['attestto_user_id'] as string | undefined

      if (!token || !userId) {
        // No auth context yet — retry later
        setTimeout(connect, RECONNECT_DELAY_MS)
        return
      }

      // AdonisJS Transmit SSE endpoint with channel subscription
      const channel = encodeURIComponent(`ssi/user_${userId}`)
      const url = `${API_BASE}/__transmit/events?channels[]=${channel}`

      eventSource = new EventSource(url, { withCredentials: true })

      eventSource.addEventListener('message', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as Record<string, unknown>

          if (data.type === 'notification') {
            chrome.runtime.sendMessage({
              type: 'NOTIFICATION_RECEIVED',
              payload: (data.message as string) ?? 'New notification',
            })
          }

          if (data.type === 'credential_offer') {
            chrome.runtime.sendMessage({
              type: 'CREDENTIAL_OFFER',
              payload: {
                format: data.format ?? 'sd-jwt',
                raw: data.raw ?? '',
                issuerName: data.issuerName ?? 'Unknown Issuer',
              },
            })
          }

          if (data.type === 'wallet_link') {
            chrome.runtime.sendMessage({
              type: 'WALLET_LINK',
              payload: {
                address: data.address ?? '',
              },
            })
          }
        } catch {
          // Ignore non-JSON messages (e.g. transmit heartbeats)
        }
      })

      eventSource.addEventListener('error', () => {
        eventSource?.close()
        eventSource = null
        setTimeout(connect, RECONNECT_DELAY_MS)
      })
    }
  )
}

connect()
