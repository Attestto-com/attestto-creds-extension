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
 */
export function isGovHost(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  return GOV_TLDS.some((tld) => h.endsWith(tld))
}
