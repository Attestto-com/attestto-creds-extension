/**
 * Attestto backend client — cert scan + threat report.
 *
 * This module is imported ONLY by the background service worker.
 * Popup and content scripts must go through chrome.runtime.sendMessage
 * (CERT_SCAN_REQUEST / SUBMIT_THREAT_REPORT) — they never call these
 * functions directly.
 *
 * Privacy contract:
 *   - Scan: sends only the hostname (no path, no cookies, no user ID).
 *   - Report: sends only { findingType, severity, hostname, tld, timestamp,
 *     certVerdict?, heuristicIds?, extensionVersion }. Never URL path, page
 *     content, or any PII.
 *   - Both calls use credentials:'omit'.
 */

import { BACKEND_BASE_URL } from '@/config/backend'

// ── Scan ────────────────────────────────────────────────────────────────────

export interface CertScanResult {
  ok: boolean
  host: string
  ca?: string
  validationTier?: string
  isFreeCA?: boolean
  subjectCommonName?: string
  validFrom?: string
  validTo?: string
  daysToExpiry?: number
  expired?: boolean
  sha256?: string
  tlsVersion?: string
  error?: string
}

/**
 * Call GET /scan?host=<hostname> and return the parsed result.
 * Never throws — errors are represented by { ok: false, error }.
 */
export async function fetchCertScan(hostname: string): Promise<CertScanResult> {
  const url = `${BACKEND_BASE_URL}/scan?host=${encodeURIComponent(hostname)}`
  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  })
  if (!resp.ok) {
    return { ok: false, host: hostname, error: `HTTP ${resp.status}` }
  }
  return (await resp.json()) as CertScanResult
}

// ── Report ───────────────────────────────────────────────────────────────────

/**
 * Minimal report body — only the fields the backend contract allows.
 * Intentionally excludes full URL, page path, page content, and any PII.
 */
export interface ThreatReportBody {
  findingType: string
  severity: string
  hostname: string
  tld: string
  timestamp: string
  certVerdict?: string
  heuristicIds?: string[]
  extensionVersion: string
}

export interface ThreatReportResult {
  ok: boolean
  id?: string
  error?: string
}

/**
 * Call POST /report with the minimal allowed body.
 * Never throws — errors are represented by { ok: false, error }.
 */
export async function submitThreatReport(body: ThreatReportBody): Promise<ThreatReportResult> {
  // Whitelist-only serialisation — explicitly pick allowed fields so no
  // accidental expansion leaks extra data even if callers add properties.
  const safe: ThreatReportBody = {
    findingType: body.findingType,
    severity: body.severity,
    hostname: body.hostname,
    tld: body.tld,
    timestamp: body.timestamp,
    extensionVersion: body.extensionVersion,
    ...(body.certVerdict !== undefined ? { certVerdict: body.certVerdict } : {}),
    ...(body.heuristicIds !== undefined ? { heuristicIds: body.heuristicIds } : {}),
  }

  const resp = await fetch(`${BACKEND_BASE_URL}/report`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(safe),
  })
  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status}` }
  }
  return (await resp.json()) as ThreatReportResult
}
