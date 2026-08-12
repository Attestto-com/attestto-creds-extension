/**
 * Report-site service — single entrypoint the popup calls when the user
 * reports a suspicious site.
 *
 * Two effects, in order:
 *
 *   1. Local — ALWAYS happens. Adds the host to the user's local blocklist
 *      (chrome.storage.local via blocklist-store). Reflects immediately in
 *      computeStateForUrl (red) on next state refresh.
 *
 *   2. Community share — ONLY happens when the user opts in via the report
 *      dialog's checkbox. Posts a minimal report to the Attestto backend.
 *      Default OFF, per [[feedback_per_event_consent]] — every outbound
 *      data action requires explicit per-event consent. No "share by
 *      default" toggle anywhere.
 *
 * The community share is graceful-fail: backend doesn't exist yet (filed as
 * a separate ticket). The fetch is wrapped — failures don't block the local
 * action, don't surface as red errors, just get logged at debug level.
 * When the backend ships, this fetch starts succeeding without changing
 * any caller code.
 */

import { blockSite } from '@/utils/blocklist-store'

/** Backend endpoint for community-shared phishing reports. */
const REPORT_ENDPOINT = 'https://api.attestto.com/v1/anti-phishing/reports'

export interface ReportInput {
  /** Lowercased host (URL.host) — the suspicious site. */
  host: string
  /** Optional free-form reason the user gave. */
  reason?: string
  /** User explicitly opted to share this report. Default: false. */
  shareWithCommunity?: boolean
  /**
   * Optional context — the registry entry the brand label collided with,
   * if any. Helps the backend triage.
   */
  collidedWithRegistryHost?: string
}

export interface ReportResult {
  /** Always true if the host was valid — local block succeeds barring IO error. */
  localBlocked: boolean
  /** True only if shareWithCommunity was set AND backend submit succeeded. */
  sharedWithCommunity: boolean
  /** Present when shareWithCommunity was set AND submit failed (informational). */
  shareError?: string
}

export async function reportSite(input: ReportInput): Promise<ReportResult> {
  const result: ReportResult = {
    localBlocked: false,
    sharedWithCommunity: false,
  }

  // 1. Local — always.
  const block = await blockSite(input.host, {
    reason: input.reason,
    sharedWithCommunity: input.shareWithCommunity ?? false,
  })
  result.localBlocked = block !== null

  // 2. Community share — only if opted in.
  if (input.shareWithCommunity) {
    try {
      await submitToCommunity(input)
      result.sharedWithCommunity = true
    } catch (err) {
      // Graceful fail — local block already succeeded, that's the user-
      // visible outcome. Backend submission failure is logged for ops
      // but does NOT surface as an error in the popup.
      result.shareError = err instanceof Error ? err.message : 'Submission failed'
      console.warn('[Attestto ID] Community report submission failed:', err)
    }
  }

  return result
}

async function submitToCommunity(input: ReportInput): Promise<void> {
  const payload = {
    host: input.host,
    reportedAt: new Date().toISOString(),
    reason: input.reason ?? null,
    collidedWithRegistryHost: input.collidedWithRegistryHost ?? null,
    clientVersion: '0.1.0',
  }

  const response = await fetch(REPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // Don't send credentials; the report is anonymous from the user's perspective.
    credentials: 'omit',
  })

  if (!response.ok) {
    throw new Error(`Community submit returned ${response.status}`)
  }
}
