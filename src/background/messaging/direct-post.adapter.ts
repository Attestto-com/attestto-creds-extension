/**
 * Story 2.4 — POSTing the `direct_post` response.
 *
 * The one place credential material leaves the extension. `did-web-fetch.adapter`
 * carries the same riders for a GET, and they matter MORE here: that request
 * fetched a public document, this one carries a signed presentation about the
 * user.
 *
 * 🔒 `redirect: 'error'` is the load-bearing line. `response_uri` was bound to
 * the verifier's authority at parse time (`oid4vp-request.ts`), and a followed
 * redirect would forward the vp_token to a location that binding never checked
 * — the browser re-POSTs to the new target, so the consent screen's named party
 * and the actual recipient come apart after the user has already approved. A
 * 3xx from a verifier is therefore a failure, not a hop.
 *
 * `credentials: 'omit'` for the same reason as the GET path, plus one more:
 * attaching the user's cookies for the verifier's domain would turn a
 * presentation into an authenticated session action.
 *
 * The response body is read only to a small cap and never parsed or acted on
 * beyond its status. A verifier's reply is not a place we take instructions
 * from.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface DirectPostResult {
  ok: boolean
  status: number
}

export interface DirectPostDeps {
  fetch?: FetchLike
}

/** A verifier ack is a status, not a document. */
const MAX_ACK_BYTES = 4 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export function createDirectPost(deps: DirectPostDeps = {}) {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))

  return {
    /**
     * POST `body` to `responseUri` as `application/x-www-form-urlencoded`, the
     * encoding OpenID4VP specifies for direct_post.
     *
     * `responseUri` MUST already have been validated and bound by
     * `parseAuthorizationRequest`. This adapter re-checks the scheme as a
     * last line of defence but cannot re-derive the binding — it has no
     * client_id — so it must not be called with an unparsed URI.
     */
    async post(
      responseUri: string,
      body: Record<string, unknown>,
      opts: { timeoutMs?: number } = {},
    ): Promise<DirectPostResult> {
      // Defence in depth. The real guarantee is the parser's; this catches a
      // future caller that bypassed it.
      if (!responseUri.startsWith('https://')) {
        throw new Error('direct_post requires an https response_uri')
      }

      const form = new URLSearchParams()
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue
        form.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      try {
        const response = await doFetch(responseUri, {
          method: 'POST',
          // 🔒 A redirect would forward the presentation past the binding.
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        })

        // Drain a bounded amount so the socket closes; the content is ignored.
        await readAndDiscard(response, MAX_ACK_BYTES)

        return { ok: response.status >= 200 && response.status < 300, status: response.status }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function readAndDiscard(response: Response, maxBytes: number): Promise<void> {
  const body = response.body
  if (!body) return
  const reader = body.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength ?? 0
      if (total > maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
