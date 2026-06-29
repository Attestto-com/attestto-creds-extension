/**
 * Trust Registry — runtime lookup against the seed list (and, in future,
 * a fetched remote registry).
 *
 * ATT-630 partial. This module ships the read path used by the toolbar
 * state tracker to assign `green-verified`. The write path (admin tooling
 * to publish entries) lives in CORTEX (TrustRegistryPage.vue +
 * ssi_trusted_entities table) and is unchanged by this work.
 *
 * Today: seed list only, no network fetch. The `loadRegistry` function is
 * already async-shaped so the next iteration can swap in a fetch + cache
 * without touching call sites.
 *
 * Brand-label semantics — for `bccr.fi.cr` the brand label is `bccr`.
 * `homograph.ts` uses this to detect "looks like a trusted institution
 * but isn't" cases (e.g., `bccr.online`, `bccr.com`).
 */

import { CR_SEED_REGISTRY, type RegistryEntry } from '@/data/trust-registry-seed'

let cachedRegistry: ReadonlyArray<RegistryEntry> | null = null
let cachedHostIndex: Map<string, RegistryEntry> | null = null
let cachedBrandIndex: Map<string, RegistryEntry[]> | null = null

/**
 * Load the registry — seeded synchronously today; async-shaped so the next
 * iteration can swap to a remote fetch with offline fallback.
 */
export async function loadRegistry(): Promise<ReadonlyArray<RegistryEntry>> {
  if (cachedRegistry) return cachedRegistry
  cachedRegistry = CR_SEED_REGISTRY
  return cachedRegistry
}

async function ensureIndexed(): Promise<void> {
  if (cachedHostIndex && cachedBrandIndex) return
  const registry = await loadRegistry()
  const hostIndex = new Map<string, RegistryEntry>()
  const brandIndex = new Map<string, RegistryEntry[]>()
  for (const entry of registry) {
    hostIndex.set(entry.host.toLowerCase(), entry)
    const brand = brandLabelFromHost(entry.host)
    if (brand) {
      const list = brandIndex.get(brand) ?? []
      list.push(entry)
      brandIndex.set(brand, list)
    }
  }
  cachedHostIndex = hostIndex
  cachedBrandIndex = brandIndex
}

/**
 * Exact host match — returns the registry entry if the host is canonical.
 * Strips a leading `www.` prefix.
 */
export async function lookupHost(host: string | null | undefined): Promise<RegistryEntry | null> {
  if (!host) return null
  await ensureIndexed()
  const normalized = host.toLowerCase().replace(/^www\./, '')
  return cachedHostIndex!.get(normalized) ?? null
}

/**
 * Lookup all registry entries that share a brand label with the given host.
 * Returns [] if there is no brand-label match. Caller compares against the
 * exact host to decide if it's a legitimate match or a brand-squat candidate.
 */
export async function lookupByBrand(host: string | null | undefined): Promise<RegistryEntry[]> {
  if (!host) return []
  await ensureIndexed()
  const brand = brandLabelFromHost(host)
  if (!brand) return []
  return cachedBrandIndex!.get(brand) ?? []
}

/**
 * Extract the "brand label" — the most distinctive identifier in a host.
 * Strips known TLD/SLD suffixes; returns the leftmost remaining label.
 *
 *   bccr.fi.cr           → bccr
 *   www.bccr.fi.cr       → bccr
 *   sinpe.fi.cr          → sinpe
 *   bancobcr.com         → bancobcr
 *   conesup.mep.go.cr    → conesup
 *   ccss.sa.cr           → ccss
 *
 * Single-label hosts (no dots) return null — not a useful brand.
 */
export function brandLabelFromHost(host: string): string | null {
  const cleaned = host.toLowerCase().replace(/^www\./, '')
  const labels = cleaned.split('.').filter(Boolean)
  if (labels.length < 2) return null
  // Strip the public-suffix-like tail. We don't ship a full PSL; rough rules:
  //   - strip 2-letter ccTLD at the end (.cr)
  //   - strip known 2-label SLD prefixes (fi.cr, sa.cr, ac.cr, or.cr, co.cr, go.cr, ed.cr)
  //   - keep stripping until exactly one label remains OR we've stripped a known suffix
  const KNOWN_SLDS = new Set([
    'fi.cr', 'sa.cr', 'ac.cr', 'or.cr', 'co.cr', 'go.cr', 'ed.cr',
    'com.mx', 'com.br', 'com.ar', 'gob.mx', 'gob.cl',
  ])
  const last2 = labels.slice(-2).join('.')
  if (KNOWN_SLDS.has(last2)) {
    const remaining = labels.slice(0, -2)
    return remaining.length > 0 ? remaining[remaining.length - 1] : null
  }
  // ccTLD or simple TLD: strip 1 label.
  const remaining = labels.slice(0, -1)
  return remaining.length > 0 ? remaining[remaining.length - 1] : null
}

/** Test seam — clear cached indexes (used in unit tests). */
export function _resetRegistryCacheForTesting(): void {
  cachedRegistry = null
  cachedHostIndex = null
  cachedBrandIndex = null
}
