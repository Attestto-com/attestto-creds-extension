/**
 * Sender-trust helpers for the background message router.
 *
 * The extension exposes a postMessage bridge on every HTTPS page
 * (`credential-api.content.ts` matches all https origins). Any decision about
 * whether a message may touch key material or mutate identity MUST be keyed off
 * the `sender` object Chrome attaches to `chrome.runtime.onMessage` — it is
 * populated by the browser and cannot be forged by the page. The page-supplied
 * `payload.origin` is attacker-controlled and must never gate a trust decision.
 *
 * - `isExtensionSender` — did this message originate from the extension's own
 *   pages (popup / options / approval window), rather than a web tab? Web tabs
 *   always carry `sender.tab`; extension pages never do.
 * - `getSenderOrigin` — the trustworthy origin of the sender: the extension
 *   origin for our own pages, else Chrome's `sender.origin` (falling back to the
 *   origin of `sender.url`), normalized via the single `normalizeOrigin` (AD-15).
 */

import { normalizeOrigin } from '@/utils/origin'

/** `chrome-extension://<id>` — no trailing slash. */
function extensionOrigin(): string | null {
  try {
    // getURL('') → "chrome-extension://<id>/"; strip the trailing slash.
    return chrome.runtime.getURL('').replace(/\/$/, '') || null
  } catch {
    return null
  }
}

/**
 * True only when the message came from one of the extension's own pages
 * (popup / options / approval) — i.e. no originating tab and a `chrome-extension://`
 * URL belonging to *this* extension. Content scripts always have `sender.tab`
 * set, so a web page can never satisfy this.
 */
export function isExtensionSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender) return false
  if (sender.tab) return false
  const base = extensionOrigin()
  if (!base) return false
  return typeof sender.url === 'string' && sender.url.startsWith(`${base}/`)
}

/**
 * The trustworthy origin of a message sender, or null if it cannot be
 * determined. Reads only fields Chrome populates — never message payload.
 */
export function getSenderOrigin(
  sender: chrome.runtime.MessageSender | undefined,
): string | null {
  if (!sender) return null
  if (isExtensionSender(sender)) return extensionOrigin()
  // Web / content-script sender: Chrome sets `origin` in modern MV3; fall back
  // to deriving it from the frame URL.
  return normalizeOrigin(sender.origin) ?? normalizeOrigin(sender.url)
}
