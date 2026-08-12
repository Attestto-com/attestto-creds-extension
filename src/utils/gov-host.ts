/**
 * Costa Rica public-sector host detection.
 *
 * A "gov host" is any hostname under one of the Costa Rican second-level
 * public-sector zones: `.go.cr` (government), `.fi.cr` (finance/regulated),
 * `.sa.cr` (health), `.ac.cr` (academic), `.ed.cr` (education), `.or.cr`
 * (non-profit / chartered orgs). These are the zones our TLS snapshot covers
 * and the only scope where the proactive trust bar / badge activate.
 *
 * Shared by the toolbar badge (tab-state.ts) and the in-page trust bar
 * content script so both layers agree on what counts as a gov host.
 */

/** The public-sector second-level suffixes we recognize (with leading dot). */
export const GOV_TLDS = ['.go.cr', '.fi.cr', '.sa.cr', '.ac.cr', '.ed.cr', '.or.cr'] as const

/** Content-script match patterns, one per gov TLD. Keep in sync with GOV_TLDS. */
export const GOV_MATCH_PATTERNS = [
  '*://*.go.cr/*',
  '*://*.fi.cr/*',
  '*://*.sa.cr/*',
  '*://*.ac.cr/*',
  '*://*.ed.cr/*',
  '*://*.or.cr/*',
] as const

/**
 * True when `host` ends in one of the recognized CR public-sector suffixes.
 * Tolerant of null/undefined, case-insensitive, and strips a trailing dot.
 *
 * This is the CANONICAL gov-host predicate (Story 1.12, FR18/AD-8) — the single
 * home for the classification logic AND the oracle the serialized `analyzeSiteHealth`
 * copy is parity-tested against. `tlds` is parameterized so the same normalization
 * is applied whether the list comes from the module's `GOV_TLDS` (badge/trust-bar
 * callers) or is threaded in as data. The injected copy in `site-health.ts` cannot
 * import this (it must stay closure-free for `executeScript`), so it re-expresses
 * this exact logic and a parity test reddens if the two ever diverge.
 */
export function isGovHost(host: string | null | undefined, tlds: readonly string[] = GOV_TLDS): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  return tlds.some((tld) => h.endsWith(tld))
}
