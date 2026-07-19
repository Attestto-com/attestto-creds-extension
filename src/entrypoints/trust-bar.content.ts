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
      display: inline-block;
      width: 18px;
      height: 12px;
      border-radius: 2px;
      flex: 0 0 auto;
      background: linear-gradient(
        #002b7f 0 16.6%,
        #fff 16.6% 33.3%,
        #ce1126 33.3% 66.6%,
        #fff 66.6% 83.3%,
        #002b7f 83.3% 100%
      );
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
    }
    .org { font-weight: 700; color: #fff; white-space: nowrap; }
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

  // Subject Organization (O) — the legal entity behind the site (e.g. "Tribunal
  // Supremo de Elecciones"), when the scanner recorded it. Cast: the field is
  // optional on the snapshot and older rows omit it.
  const org = ((row as Record<string, unknown>).subjectOrganization as string | undefined)?.trim() || ''
  const orgHtml = org ? `<span class="org">${escapeText(org)}</span><span class="sep">·</span>` : ''

  bar.innerHTML = `
    <span class="mark" role="img" aria-label="Costa Rica"></span>
    ${orgHtml}
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
    clearPagePush()
    void dismissTrustBarForHost(host)
  })
  bar.appendChild(close)

  shadow.appendChild(style)
  shadow.appendChild(bar)
  return hostEl
}

/** True on an insecure (http:) page, or one whose forms POST over http://. */
function isInsecurePage(): boolean {
  if (window.location.protocol === 'http:') return true
  return Array.from(document.querySelectorAll<HTMLFormElement>('form[action]')).some(
    (f) => /^http:\/\//i.test(f.getAttribute('action') || ''),
  )
}

const PII_HINT =
  /c[eé]dula|identificaci|correo|e-?mail|tel[eé]fono|phone|nombre|passport|pasaporte|\bdni\b|\bnif\b|contrase|password/i

/**
 * True when the page collects credentials or personal data: a password field,
 * an email field, or ≥2 inputs whose name/id/placeholder hint at national ID /
 * email / phone / name. Tuned to fire on real registration/login forms.
 */
function hasSensitiveForm(): boolean {
  if (document.querySelector('input[type="password"]')) return true
  const fields = Array.from(document.querySelectorAll('input, textarea, select'))
  if (fields.length < 2) return false
  if (document.querySelector('input[type="email"]')) return true
  let hits = 0
  for (const el of fields) {
    const hay = `${el.getAttribute('name') || ''} ${el.id} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('autocomplete') || ''}`
    if (PII_HINT.test(hay) && ++hits >= 2) return true
  }
  return false
}

/**
 * Red alert bar for an insecure page asking for personal data. Unlike the TLS
 * bar this does NOT depend on the snapshot — it fires from the live page (HTTP +
 * sensitive form). Bilingual by browser locale (CR gov audience = Spanish).
 */
function buildInsecureBar(host: string): HTMLElement {
  const es = (navigator.language || '').toLowerCase().startsWith('es')
  const msg = es
    ? 'Sitio no seguro (sin cifrado) que solicita datos personales. No ingrese su cédula, correo ni contraseña aquí.'
    : 'Not secure (unencrypted) and asking for personal data. Don’t enter your ID, email, or password here.'
  const dismissLabel = es ? 'Descartar la advertencia de Attestto' : 'Dismiss the Attestto warning'

  const hostEl = document.createElement('div')
  hostEl.id = HOST_ELEMENT_ID
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
      pointer-events: auto; box-sizing: border-box; display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 8px 12px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; font-size: 13px; line-height: 1.4;
      color: #fee2e2; background: rgba(69,10,10,0.98); border-bottom: 2px solid #dc2626;
      box-shadow: 0 1px 6px rgba(0,0,0,0.35);
    }
    .mark { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:4px; background:#dc2626; color:#fff; font-weight:700; font-size:13px; flex:0 0 auto; }
    .msg { color:#fecaca; }
    .host { font-weight:600; color:#fff; }
    .close { pointer-events:auto; margin-left:auto; flex:0 0 auto; appearance:none; border:0; background:transparent; color:#fca5a5; font-size:16px; line-height:1; cursor:pointer; padding:2px 6px; border-radius:4px; }
    .close:hover { color:#fff; background:rgba(255,255,255,0.1); }
  `

  const bar = document.createElement('div')
  bar.className = 'bar'
  bar.setAttribute('role', 'alert')
  bar.innerHTML = `
    <span class="mark" aria-hidden="true">!</span>
    <span class="msg"><span class="host">${escapeText(host)}</span> — ${escapeText(msg)}</span>
  `

  const close = document.createElement('button')
  close.className = 'close'
  close.type = 'button'
  close.setAttribute('aria-label', dismissLabel)
  close.textContent = '×'
  close.addEventListener('click', () => {
    hostEl.remove()
    clearPagePush()
    void dismissTrustBarForHost(host)
  })
  bar.appendChild(close)

  shadow.appendChild(style)
  shadow.appendChild(bar)
  return hostEl
}

/**
 * Push the whole page down by the bar height so the fixed bar never overlaps
 * site content. Applied to <html> with !important so a site's own margin can't
 * defeat it; cleared on dismiss.
 */
function applyPagePush(px: number): void {
  if (px > 0) document.documentElement.style.setProperty('margin-top', `${px}px`, 'important')
}

/** Restore the page when the bar is dismissed. */
export function clearPagePush(): void {
  document.documentElement.style.removeProperty('margin-top')
}

/** Mount a bar element once the DOM body exists (idempotent). */
function mountBar(bar: HTMLElement): void {
  const doMount = () => {
    if (document.getElementById(HOST_ELEMENT_ID)) return
    ;(document.body || document.documentElement).appendChild(bar)
    // Reading height forces layout, so the fixed bar is measured before we
    // offset the page by exactly its height.
    applyPagePush(Math.round(bar.getBoundingClientRect().height))
  }
  if (document.body) doMount()
  else document.addEventListener('DOMContentLoaded', doMount, { once: true })
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

    // Guard against double-injection (SPA re-entry / re-run).
    if (document.getElementById(HOST_ELEMENT_ID)) return

    // 1. Insecure page collecting PII/credentials — highest priority, red alert.
    //    Independent of the TLS snapshot (HTTP hosts aren't in it).
    if (isInsecurePage() && hasSensitiveForm()) {
      mountBar(buildInsecureBar(host))
      return
    }

    // 2. TLS snapshot bar (HTTPS hosts in our bundled offline snapshot).
    const row = await lookupTls(host)
    if (!row || !row.ok) return
    mountBar(buildBar(row, host))
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
