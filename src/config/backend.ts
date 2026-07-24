/**
 * Backend service configuration.
 *
 * The extension routes cert-scan and threat-report requests through the
 * background service worker (which has no CSP restrictions on fetch). Popup
 * and content scripts NEVER fetch directly — they send a chrome.runtime
 * message and await the SW response.
 *
 * Override VITE_BACKEND_URL at build time for production:
 *   VITE_BACKEND_URL=https://scan.attestto.com npm run build
 *
 * CSP note (for when popup direct-fetch is ever added):
 *   wxt.config.ts content_security_policy.extension_pages must include:
 *     connect-src 'self' http://localhost:8787 https://scan.attestto.com
 */
export const BACKEND_BASE_URL: string =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8787'
