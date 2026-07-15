/**
 * Content Script — in-page gov TLS trust bar (Layer 2).
 *
 * Scoped ONLY to Costa Rican public-sector zones (`.go.cr`, `.fi.cr`, `.sa.cr`,
 * `.ac.cr`, `.ed.cr`, `.or.cr`) — NEVER `<all_urls>`. On a gov page whose host
 * is in our bundled TLS snapshot, it injects a thin fixed bar at the top of the
 * viewport summarizing what our offline scanner recorded for that host's
 * certificate (CA, DV/OV/EV tier, free-vs-paid, expiry, snapshot date).
 *
 * Design notes:
 *   - Shadow DOM (`mode:'open'`) isolates our styles from the page and vice
 *     versa. The page's CSS cannot restyle or hide the bar.
 *   - "Don't nag": EV/OV/healthy → quiet neutral bar. DV or expired → assertive
 *     amber/red accent. Colors mirror SiteIdentityCard / the toolbar badge.
 *   - Opt-out: respects the `trustBarEnabled` setting (default TRUE).
 *   - Per-host dismiss: × remembers the host; the bar never returns there.
 *   - Fail soft: any error → no bar, no console spam.
 *
 * This is a DISPLAY feature only — it reports the snapshot, never the live cert
 * (MV3 cannot read the served leaf cert).
 */

import { isGovHost, GOV_MATCH_PATTERNS } from '@/utils/gov-host'
import { lookupTls, snapshotDate, type TlsSnapshotRow } from '@/utils/tls-snapshot'
import { readSettings } from '@/utils/settings-config'
import { isTrustBarDismissed, dismissTrustBarForHost } from '@/utils/trust-bar-dismissed'

const HOST_ELEMENT_ID = 'attestto-trust-bar-host'

/** DV/OV/EV chip colors — mirror SiteIdentityCard / toolbar badge language. */
const TIER_COLORS: Record<string, { bg: string; fg: string }> = {
  EV: { bg: 'rgba(22,163,74,0.15)', fg: '#16a34a' },
  OV: { bg: 'rgba(37,99,235,0.15)', fg: '#2563eb' },
  DV: { bg: 'rgba(217,119,6,0.15)', fg: '#d97706' },
}

function escapeText(s: string): string {
  const el = document.createElement('span')
  el.textContent = s
  return el.innerHTML
}

/** Whether this row should render the assertive (warning) treatment. */
function isAssertive(row: TlsSnapshotRow): boolean {
  if (row.expired) return true
  if (typeof row.daysToExpiry === 'number' && row.daysToExpiry < 0) return true
  return row.validationTier === 'DV'
}

function tierChipHtml(row: TlsSnapshotRow): string {
  const tier = row.validationTier
  const c = TIER_COLORS[tier]
  if (!c) return ''
  return `<span class="chip" style="background:${c.bg};color:${c.fg};">${escapeText(tier)}</span>`
}

function expiryHtml(row: TlsSnapshotRow): string {
  if (row.expired) {
    return `<span class="expiry expiry-bad">certificate expired</span>`
  }
  if (typeof row.daysToExpiry === 'number') {
    if (row.daysToExpiry < 0) {
      return `<span class="expiry expiry-bad">certificate expired</span>`
    }
    const cls = row.daysToExpiry < 30 ? 'expiry expiry-soon' : 'expiry'
    return `<span class="${cls}">expires in ${row.daysToExpiry} days</span>`
  }
  return ''
}

function buildBar(row: TlsSnapshotRow, host: string): HTMLElement {
  const assertive = isAssertive(row)
  const accent = row.expired ? '#dc2626' : assertive ? '#d97706' : '#334155'
  const barBg = assertive ? 'rgba(20,17,10,0.97)' : 'rgba(15,23,42,0.97)'

  const snapDate = snapshotDate()
  const freePaid = row.isFreeCA ? 'free CA' : 'paid CA'

  const hostEl = document.createElement('div')
  hostEl.id = HOST_ELEMENT_ID
  // Position the host element itself; the visible bar lives in the shadow root.
  hostEl.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'width:100%',
    'z-index:2147483647',
    'pointer-events:none',
  ].join(';')

  const shadow = hostEl.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .bar {
      pointer-events: auto;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 6px 12px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      color: #e2e8f0;
      background: ${barBg};
      border-bottom: 2px solid ${accent};
      box-shadow: 0 1px 6px rgba(0,0,0,0.25);
    }
    .mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 4px;
      background: #0f766e;
      color: #fff;
      font-weight: 700;
      font-size: 11px;
      flex: 0 0 auto;
    }
    .host { font-weight: 600; color: #fff; white-space: nowrap; }
    .sep { color: #64748b; }
    .ca { color: #cbd5e1; white-space: nowrap; }
    .free { color: #94a3b8; white-space: nowrap; }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    .expiry { color: #cbd5e1; white-space: nowrap; }
    .expiry-soon { color: #fbbf24; }
    .expiry-bad { color: #f87171; font-weight: 600; }
    .asof { color: #64748b; margin-left: auto; white-space: nowrap; }
    .close {
      pointer-events: auto;
      flex: 0 0 auto;
      appearance: none;
      border: 0;
      background: transparent;
      color: #94a3b8;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .close:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .spacer { display: inline-block; }
  `

  const bar = document.createElement('div')
  bar.className = 'bar'
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')

  const asOf = snapDate ? `<span class="asof">as of ${escapeText(snapDate)}</span>` : ''

  bar.innerHTML = `
    <span class="mark" aria-hidden="true">A</span>
    <span class="host">${escapeText(host)}</span>
    <span class="sep">·</span>
    <span class="ca">${escapeText(row.ca || 'unknown CA')}</span>
    ${tierChipHtml(row)}
    <span class="free">${escapeText(freePaid)}</span>
    ${expiryHtml(row)}
    ${asOf}
  `

  const close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss Attestto trust bar for this site')
  close.textContent = '×'
  close.addEventListener('click', () => {
    hostEl.remove()
    void dismissTrustBarForHost(host)
  })
  bar.appendChild(close)

  shadow.appendChild(style)
  shadow.appendChild(bar)
  return hostEl
}

async function run(): Promise<void> {
  try {
    const host = window.location.hostname.toLowerCase()
    if (!isGovHost(host)) return

    // Opt-out preference (default true).
    const settings = await readSettings()
    if (!settings.trustBarEnabled) return

    // Per-host dismissal memory.
    if (await isTrustBarDismissed(host)) return

    // Only render on a snapshot hit.
    const row = await lookupTls(host)
    if (!row || !row.ok) return

    // Guard against double-injection (SPA re-entry / re-run).
    if (document.getElementById(HOST_ELEMENT_ID)) return

    const bar = buildBar(row, host)
    const mount = () => {
      if (document.getElementById(HOST_ELEMENT_ID)) return
      ;(document.body || document.documentElement).appendChild(bar)
    }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })
  } catch {
    // Fail soft — no bar, no console noise.
  }
}

export default defineContentScript({
  matches: [...GOV_MATCH_PATTERNS],
  runAt: 'document_idle',
  world: 'ISOLATED',
  main() {
    void run()
  },
})
