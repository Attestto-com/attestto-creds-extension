/**
 * Story 2.1 — the `DidWebFetch` adapter. The ONLY place `fetch` is called on a
 * URL a web page influenced, and therefore the only place the transport-level
 * SSRF riders can be enforced.
 *
 * `did-web-url.ts` decides WHERE we are willing to go. This decides HOW, and the
 * two must both hold: a perfect host allowlist is worthless if the server is
 * allowed to answer `302 → http://169.254.169.254/`, because the host check ran
 * against the URL we built, not the one the browser would ultimately load.
 *
 * The riders, each of which the spec below proves bites:
 *
 *   `redirect: 'error'`      the check above stays meaningful
 *   `credentials: 'omit'`    no cookies for a request a page chose the target of
 *   `cache: 'no-store'`      TTL is the resolver's to own, not the HTTP cache's
 *   `referrerPolicy`         a did:web host learns nothing about the user's tabs
 *   AbortController timeout  a hung socket must not pin a service worker awake
 *   streamed byte cap        `res.text()` on a multi-GB body is an OOM, and the
 *                            resolver's post-hoc length check would run only
 *                            after the whole body had already been buffered
 *
 * `fetch` is injected rather than referenced globally so the spec can prove each
 * rider is passed and the byte cap actually stops reading.
 */

/** The subset of `fetch` this adapter uses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface DidWebFetchAdapterDeps {
  fetch?: FetchLike
}

/** Thrown when the body exceeds `maxBytes`; surfaces as `fetch-failed`. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super('DID document exceeded the byte cap')
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Read at most `maxBytes` from the body, aborting as soon as the cap is passed.
 *
 * Deliberately NOT `await response.text()`: that buffers the entire body first,
 * so a size check afterwards has already paid the cost it was meant to avoid.
 * A body with no reader (an empty response) yields the empty string.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (!body) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new ResponseTooLargeError()
      chunks.push(value)
    }
  } finally {
    // Releases the socket whether we finished or bailed out at the cap.
    await reader.cancel().catch(() => undefined)
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

export function createDidWebFetch(deps: DidWebFetchAdapterDeps = {}) {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))

  return {
    async getJson(url: string, opts: { timeoutMs: number; maxBytes: number }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
      try {
        const response = await doFetch(url, {
          method: 'GET',
          // 🔒 Refusing redirects is what keeps the host allowlist honest.
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: { Accept: 'application/did+json, application/json' },
        })

        const body = await readCapped(response, opts.maxBytes)
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
