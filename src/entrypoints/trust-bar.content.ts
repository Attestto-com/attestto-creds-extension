/**
 * Content Script — insecure-page warning bar.
 *
 * Scoped ONLY to Costa Rican public-sector zones (`.go.cr`, `.fi.cr`, `.sa.cr`,
 * `.ac.cr`, `.ed.cr`, `.or.cr`) — NEVER `<all_urls>`. On an insecure HTTP gov
 * page that collects personal data it injects a red fixed warning bar.
 *
 * Design notes:
 *   - Shadow DOM (`mode:'open'`) isolates our styles from the page and vice
 *     versa. The page's CSS cannot restyle or hide the bar.
 *   - Opt-out: respects the `trustBarEnabled` setting (default TRUE).
 *   - Per-host dismiss: × remembers the host; the bar never returns there.
 *   - Fail soft: any error → no bar, no console spam.
 *
 * This is a WARNING feature only — it fires on HTTP pages with sensitive forms.
 * The positive TLS info-bar has been removed; only the insecure/threat path remains.
 */

import { isGovHost, GOV_MATCH_PATTERNS } from '@/utils/gov-host'
import { readSettings } from '@/utils/settings-config'
import { isTrustBarDismissed, dismissTrustBarForHost } from '@/utils/trust-bar-dismissed'

const HOST_ELEMENT_ID = 'attestto-trust-bar-host'

function escapeText(s: string): string {
  const el = document.createElement('span')
  el.textContent = s
  return el.innerHTML
}

/** True on an insecure (http:) page, or one whose forms POST over http://. */
export function isInsecurePage(): boolean {
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
export function hasSensitiveForm(): boolean {
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
    : "Not secure (unencrypted) and asking for personal data. Don't enter your ID, email, or password here."
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

    // Insecure page collecting PII/credentials — red alert.
    // Independent of the TLS snapshot (HTTP hosts aren't in it).
    if (isInsecurePage() && hasSensitiveForm()) {
      mountBar(buildInsecureBar(host))
    }
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
