/**
 * Per-tab toolbar trust state — the unspoofable passive cue.
 *
 * ATT-727. After the on-page bar was removed (ATT-726, spoofable), the toolbar
 * icon is the surface a malicious page cannot reach. This module owns:
 *
 *   1. A trust-state machine (neutral / green-pinned / green-verified /
 *      yellow-heuristic / yellow-cert / red).
 *   2. Per-tab tracking — switching tabs flips the icon to that tab's state.
 *   3. Programmatic icon tinting via OffscreenCanvas so we ship 1 base icon
 *      instead of 6 design variants. The base PNG already exists; we tint it
 *      at runtime with state-specific overlays.
 *   4. Badge overlay ('!') for yellow / red — extra-visible cue.
 *   5. Throttled chrome.notifications for RED transitions (gated by user
 *      setting). Scaffolded here; no signal source for RED state yet — that
 *      lights up when ATT-705 (cert verifier) and ATT-630 (Trust Registry)
 *      land upstream.
 *
 * Honest limits today (per ATT-727):
 *
 *   - Without Trust Registry + cert verifier, the icon mostly stays
 *     `neutral` or `green-pinned`. Pin store is the only live signal.
 *   - Service worker restarts wipe the in-memory state. For tabs the user
 *     was already on at restart, icon stays neutral until they navigate
 *     again (we cache URL via webNavigation, not via chrome.tabs.get,
 *     to avoid the `tabs` permission and its "read your browsing history"
 *     install warning).
 *   - Notification UX needs Chrome / Brave / Edge testing — chrome.action
 *     behaves slightly differently per browser.
 */

import { isPinned, onPinStoreChanged } from '@/utils/pin-store'
import { isBlocked, onBlocklistChanged } from '@/utils/blocklist-store'
import { readSettings } from '@/utils/settings-config'
import { lookupHost } from '@/utils/trust-registry'
import { homographState } from '@/utils/homograph'
import { isGovHost } from '@/utils/gov-host'
import { lookupTls } from '@/utils/tls-snapshot'

export type TrustState =
  | 'neutral'
  | 'green-pinned'
  | 'green-verified'
  | 'yellow-heuristic'
  | 'yellow-cert'
  | 'red'

interface StateVisual {
  /** RGBA tint applied over the base icon. Alpha=0 means no tint. */
  tint: readonly [number, number, number, number]
  /** Optional badge text + bg color. Omitted = no badge. */
  badge?: { text: string; bg: string }
}

/**
 * Single source of truth for state → visual mapping.
 * Popup and toolbar must agree on these colors; if the popup later renders a
 * verdict chip, it imports STATE_VISUALS rather than redefining colors.
 */
export const STATE_VISUALS: Record<TrustState, StateVisual> = {
  neutral: { tint: [0, 0, 0, 0] },
  'green-pinned': { tint: [16, 185, 129, 0.35] },
  'green-verified': { tint: [16, 185, 129, 0.55] },
  'yellow-heuristic': {
    tint: [234, 179, 8, 0.45],
    badge: { text: '!', bg: '#eab308' },
  },
  'yellow-cert': {
    tint: [234, 179, 8, 0.45],
    badge: { text: '!', bg: '#eab308' },
  },
  red: {
    tint: [239, 68, 68, 0.6],
    badge: { text: '!', bg: '#ef4444' },
  },
}

const ICON_SIZES = [16, 32, 48, 128] as const
type IconSize = (typeof ICON_SIZES)[number]
type IconSet = Record<number, ImageData>

/** Tinted-icon cache keyed by state — built lazily, kept for SW lifetime. */
const iconCache = new Map<TrustState, IconSet>()

/** Last-known URL per tab (populated by webNavigation, NOT by tabs.get). */
const tabUrls = new Map<number, string>()

/** Last computed state per tab — used to detect transitions (e.g. → red). */
const tabStates = new Map<number, TrustState>()

/** Hosts already notified this SW lifetime — prevents notification spam. */
const redNotifiedThisSession = new Set<string>()

/**
 * Compute the trust state for a URL.
 *
 * Precedence (high → low):
 *
 *   1. User blocklist RED     — strongest negative signal. User explicitly
 *                               reported / blocked this host. Overrides
 *                               everything, including their own pin (if
 *                               they accidentally pinned then later
 *                               blocked, blocked wins).
 *   2. Homograph RED          — brand-squat (registered institution's
 *                               brand label on a non-canonical host)
 *                               overrides pin / registry. A user could
 *                               have pinned a phishing site before the
 *                               squat was detected — we still warn.
 *   3. Pin store GREEN-PINNED — user-explicit trust beats institutional
 *                               trust. If they pin a non-registered
 *                               domain, that is their decision.
 *   4. Registry GREEN-VERIFIED — institutional allowlist match.
 *   5. Homograph YELLOW       — weaker signals (punycode-only, etc.).
 *   6. Cert verifier YELLOW   — future (ATT-705 backend service).
 *   7. NEUTRAL                — default.
 */
export async function computeStateForUrl(url: string): Promise<TrustState> {
  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return 'neutral'
  }
  if (!host) return 'neutral'

  // 1. User-explicit distrust — strongest signal.
  if (await isBlocked(host)) return 'red'

  // 2. Brand-squat heuristic — also red, overrides user pins.
  const homograph = await homographState(host)
  if (homograph === 'red') return 'red'

  // 3. User-explicit trust.
  if (await isPinned(host)) return 'green-pinned'

  // 4. Institutional allowlist.
  if (await lookupHost(host)) return 'green-verified'

  // 5. Weaker heuristic signals.
  if (homograph === 'yellow-heuristic') return 'yellow-heuristic'

  // 6. Cert verifier (future, ATT-705 — needs backend service).
  //   if (await certTierConcern(host)) return 'yellow-cert'

  return 'neutral'
}

/**
 * Load the base icon at a given size and apply a tint via OffscreenCanvas.
 * Returns ImageData ready for chrome.action.setIcon.
 */
async function buildTintedIcon(size: IconSize, tint: StateVisual['tint']): Promise<ImageData> {
  const url = chrome.runtime.getURL(`icon/${size}.png`)
  const response = await fetch(url)
  const blob = await response.blob()
  const bitmap = await createImageBitmap(blob)

  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')

  ctx.drawImage(bitmap, 0, 0, size, size)

  if (tint[3] > 0) {
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${tint[3]})`
    ctx.fillRect(0, 0, size, size)
  }

  return ctx.getImageData(0, 0, size, size)
}

async function getTintedIconSet(state: TrustState): Promise<IconSet> {
  const cached = iconCache.get(state)
  if (cached) return cached
  const tint = STATE_VISUALS[state].tint
  const entries = await Promise.all(
    ICON_SIZES.map(async (size) => [size, await buildTintedIcon(size, tint)] as const),
  )
  const set: IconSet = Object.fromEntries(entries)
  iconCache.set(state, set)
  return set
}

/**
 * Apply the icon + badge for a state to a specific tab.
 * Per-tab — popup of tab A shows tab A's state, popup of tab B shows tab B's.
 */
async function applyToTab(tabId: number, state: TrustState): Promise<void> {
  try {
    const imageData = await getTintedIconSet(state)
    await chrome.action.setIcon({ tabId, imageData })
  } catch (err) {
    // Tab may have closed between event and apply — non-fatal.
    console.debug('[Attestto ID] setIcon skipped:', err)
    return
  }

  const visual = STATE_VISUALS[state]
  if (visual.badge) {
    await chrome.action.setBadgeText({ tabId, text: visual.badge.text }).catch(() => {})
    await chrome.action
      .setBadgeBackgroundColor({ tabId, color: visual.badge.bg })
      .catch(() => {})
  } else {
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
  }
}

/**
 * Gov-site TLS validation badge (passive, positive cue).
 *
 * When the active tab is a Costa Rican public-sector host AND that host is in
 * our bundled TLS snapshot, stamp a per-tab EV/OV/DV badge on the toolbar icon:
 *   - EV → green (#16a34a)
 *   - OV → blue  (#2563eb)
 *   - DV → amber (#d97706)
 *   - expired cert → red (#dc2626), overriding the tier color
 *
 * Returns `true` if it painted a gov badge (so the caller skips clearing it),
 * `false` for non-gov / non-snapshot tabs. Fails soft — any error → no badge.
 *
 * This is layered ON TOP of the anti-phishing state machine: the '!' warning
 * badge (yellow/red states) always wins, so we only paint the gov tier badge
 * when the trust state itself carries no badge (neutral / green).
 */
async function applyGovTlsBadge(tabId: number, host: string): Promise<boolean> {
  try {
    if (!isGovHost(host)) return false
    const row = await lookupTls(host)
    if (!row || !row.ok) return false

    let text: string
    let color: string
    if (row.expired) {
      text = row.validationTier === 'unknown' ? 'DV' : row.validationTier
      color = '#dc2626' // red — expired trumps tier
    } else {
      switch (row.validationTier) {
        case 'EV':
          text = 'EV'
          color = '#16a34a'
          break
        case 'OV':
          text = 'OV'
          color = '#2563eb'
          break
        case 'DV':
          text = 'DV'
          color = '#d97706'
          break
        default:
          // 'unknown' tier — no meaningful tier cue, leave badge alone.
          return false
      }
    }

    await chrome.action.setBadgeText({ tabId, text }).catch(() => {})
    await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {})
    return true
  } catch (err) {
    console.debug('[Attestto ID] gov TLS badge skipped:', err)
    return false
  }
}

/**
 * Re-evaluate a tab and apply icon. Fires notifications on transitions
 * into RED (when that state ever triggers in the future).
 */
async function refreshTab(tabId: number, url: string | undefined): Promise<void> {
  if (!url || !/^https?:/.test(url)) {
    // chrome:// / about: / file: / etc — neutral, no badge, no tracking.
    tabStates.set(tabId, 'neutral')
    await applyToTab(tabId, 'neutral')
    return
  }

  tabUrls.set(tabId, url)
  const state = await computeStateForUrl(url)
  const prev = tabStates.get(tabId)
  tabStates.set(tabId, state)
  await applyToTab(tabId, state)

  // Gov-site TLS tier badge — passive positive cue, only when the anti-phishing
  // state carries no warning badge of its own (neutral / green states).
  if (!STATE_VISUALS[state].badge) {
    let host = ''
    try {
      host = new URL(url).host.toLowerCase()
    } catch {
      host = ''
    }
    if (host) await applyGovTlsBadge(tabId, host)
  }

  if (state === 'red' && prev !== 'red') {
    await maybeNotifyRed(url)
  }
}

/**
 * OS-level notification for RED state. Throttled per-host per SW lifetime
 * to avoid spam; gated by `settings.notifyOnRed`.
 *
 * No RED triggers exist in `computeStateForUrl` yet — this is dead-code-ready
 * scaffolding so the surface is fully wired the moment ATT-630 / ATT-705 add
 * red-producing signals.
 */
async function maybeNotifyRed(url: string): Promise<void> {
  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return
  }
  if (redNotifiedThisSession.has(host)) return
  redNotifiedThisSession.add(host)

  const settings = await readSettings()
  if (!settings.notifyOnRed) return

  try {
    await chrome.notifications.create(`red-${host}-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title: 'Attestto — possible impersonation',
      message: `${host} did not pass verification. Click the Attestto icon for details.`,
      priority: 2,
      requireInteraction: false,
    })
  } catch (err) {
    console.warn('[Attestto ID] RED notification failed:', err)
  }
}

/**
 * Wire all listeners. Call once from the background SW entrypoint.
 */
export function initToolbarStateTracker(): void {
  // Tab switched into focus — repaint icon for the newly active tab.
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    const url = tabUrls.get(tabId)
    void refreshTab(tabId, url)
  })

  // URL / load state changed in a tab — repaint icon if URL changed.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
    if (changeInfo.url) {
      void refreshTab(tabId, changeInfo.url)
    }
  })

  // Primary URL source — fires for every top-frame navigation across all tabs.
  // Using webNavigation lets us skip the `tabs` permission ("read browsing
  // history") at install.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return // top frame only
    void refreshTab(details.tabId, details.url)
  })

  // SPA navigations (pushState/replaceState).
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return
    void refreshTab(details.tabId, details.url)
  })

  // Navigations that ERROR — TLS cert mismatch, NET::ERR_*, DNS failure, etc.
  // Critical for the anti-phishing path: brand-squat sites frequently have
  // broken TLS (squatters skip proper certs), so Chrome blocks them at the
  // cert layer and onCommitted never fires with the real URL. We still want
  // to paint the toolbar with our verdict against the URL the user TRIED to
  // visit — that's the whole point of "this is impersonating BCCR." Without
  // this listener, the demo case `https://bccr.com/` stays neutral.
  chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId !== 0) return
    void refreshTab(details.tabId, details.url)
  })

  // Pin store changed — re-evaluate every tab whose URL we know about so the
  // icon updates without the user having to navigate.
  onPinStoreChanged(async () => {
    for (const [tabId, url] of tabUrls.entries()) {
      await refreshTab(tabId, url)
    }
  })

  // Blocklist changed — same idea, repaint affected tabs without nav.
  onBlocklistChanged(async () => {
    for (const [tabId, url] of tabUrls.entries()) {
      await refreshTab(tabId, url)
    }
  })

  // Clean up state when a tab closes.
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrls.delete(tabId)
    tabStates.delete(tabId)
  })
}

/** Test seam — read the current state for a tab. */
export function getTabStateForTesting(tabId: number): TrustState | undefined {
  return tabStates.get(tabId)
}
