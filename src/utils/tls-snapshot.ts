/**
 * Bundled CR public-sector TLS certificate snapshot.
 *
 * Chrome MV3 extensions cannot read the served TLS certificate of the active
 * page (there is no API to inspect the connection's leaf cert). So instead of a
 * live fetch, the extension ships a static snapshot produced offline by our
 * `@attestto/tls-audit` scanner and keyed by hostname. This module loads that
 * snapshot from the extension's web-accessible assets and offers a
 * case-insensitive host lookup.
 *
 * This is a DISPLAY/READ feature only — it never contacts the network and never
 * asserts anything about the cert currently served; it reports what the scanner
 * saw at snapshot time.
 */

import type { TlsClassification } from '@attestto/tls-audit'

/**
 * A single snapshot row. It is the browser-safe `TlsClassification` shape plus
 * the scan envelope (`host`, `ok`, `error`) the scanner records. Rows with
 * `ok:false` have `error` set and empty/placeholder classification fields.
 */
export type TlsSnapshotRow = TlsClassification & {
  host: string
  ok: boolean
  error: string | null
  /** TLS protocol version seen during the scan (informational). */
  tlsVersion?: string | null
}

/**
 * On-disk shape of the packaged snapshot: a `generatedAt` scan date plus the
 * per-host classification rows. `generatedAt` may be absent on older snapshots.
 */
export type TlsSnapshotFile = {
  generatedAt?: string | null
  hosts: TlsSnapshotRow[]
}

/** In-memory cache — the snapshot is immutable for the extension's lifetime. */
let snapshotCache: TlsSnapshotRow[] | null = null
let generatedAtCache: string | null = null
let loadPromise: Promise<TlsSnapshotRow[]> | null = null

/** Resolve the packaged snapshot URL (web-accessible resource). */
function snapshotUrl(): string {
  return chrome.runtime.getURL('data/cr-tls-snapshot.json')
}

/**
 * Load and cache the bundled snapshot. Never throws — a missing or malformed
 * file resolves to an empty array so the UI degrades gracefully.
 */
export async function loadTlsSnapshot(): Promise<TlsSnapshotRow[]> {
  if (snapshotCache) return snapshotCache
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      const res = await fetch(snapshotUrl())
      if (!res.ok) throw new Error(`snapshot fetch ${res.status}`)
      const data = (await res.json()) as unknown
      if (Array.isArray(data)) {
        // Legacy shape: a bare array of rows, no scan date.
        snapshotCache = data as TlsSnapshotRow[]
        generatedAtCache = null
      } else if (data && typeof data === 'object' && Array.isArray((data as TlsSnapshotFile).hosts)) {
        const file = data as TlsSnapshotFile
        snapshotCache = file.hosts
        generatedAtCache = typeof file.generatedAt === 'string' ? file.generatedAt : null
      } else {
        snapshotCache = []
        generatedAtCache = null
      }
    } catch (err) {
      console.debug('[Attestto ID] TLS snapshot load failed:', err)
      snapshotCache = []
      generatedAtCache = null
    }
    return snapshotCache
  })()

  return loadPromise
}

/**
 * The snapshot's `generatedAt` scan date, or `null` if the snapshot has not
 * been loaded yet or predates the dated format. Call after `loadTlsSnapshot`
 * (or any `lookupTls`) has resolved to get a meaningful value.
 */
export function snapshotDate(): string | null {
  return generatedAtCache
}

/** Lowercase, trimmed host — tolerant of null/undefined. */
function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null
  const h = host.trim().toLowerCase()
  return h || null
}

/**
 * Look up a host in the bundled snapshot.
 *
 * Match strategy: exact host first, then try the `www.`-toggled variant so a
 * caller passing either `hacienda.go.cr` or `www.hacienda.go.cr` resolves to the
 * `www.hacienda.go.cr` row (the extension UI strips `www.` before display, but
 * the scanner records the canonical served host). Returns `null` when the host
 * is not part of the public-sector snapshot.
 */
export async function lookupTls(host: string): Promise<TlsSnapshotRow | null> {
  const target = normalizeHost(host)
  if (!target) return null

  const rows = await loadTlsSnapshot()
  const byHost = (h: string) => rows.find((r) => normalizeHost(r.host) === h) ?? null

  // 1. Exact host.
  const exact = byHost(target)
  if (exact) return exact

  // 2. Toggle the leading `www.` and try again.
  const toggled = target.startsWith('www.') ? target.slice(4) : `www.${target}`
  return byHost(toggled)
}
