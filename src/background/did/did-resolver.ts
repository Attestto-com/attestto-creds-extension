/**
 * Story 2.1 — the `CounterpartyDid` port implementation (AD-9).
 *
 * Pure module: no `chrome.*`, no `fetch`, no side effects at import time. The
 * network arrives as an injected `DidWebFetch`, the wall clock as `Clock`, so
 * every rider below (TTL, rate limit, timeout accounting) is testable without a
 * timer and without a server.
 *
 * ── Order of operations, and why it is this order ──────────────────────────
 *
 *   1 parse syntax            — before anything reads `method`
 *   2 method allowlist        — before the cache, so a cached document can
 *                               never be returned to a caller whose allowlist
 *                               excludes its method
 *   3 cache read              — positive entries only
 *   4 rate limit              — before the fetch, not after
 *   5 method-specific resolve — `jwk` locally, `web` over HTTPS
 *   6 document parse + id check
 *   7 cache write
 *
 * Step 2 before step 3 is load-bearing and easy to get backwards: caching is
 * keyed on the DID alone (the document does not depend on who asked), so the
 * allowlist has to be enforced on every call rather than only on the miss path.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────
 *
 * Every path either returns a validated `DidDocument` or throws
 * `DidResolutionError`. There is no null return and no partial document, so a
 * caller cannot accidentally treat "could not resolve" as "resolved to nothing"
 * — the distinction that made `detokenize` returning `{value:null}` a defect on
 * a decision path in CORTEX.
 *
 * Failures are NOT cached. A negative cache would let one transient outage
 * lock out a legitimate counterparty for the whole TTL, and an attacker who can
 * force one failure could pin it. The rate limiter, not the cache, is what
 * bounds retry cost.
 */
import { parseDid, type DidSyntaxReason } from './did-syntax'
import { buildDidWebUrl, type DidWebUrlReason } from './did-web-url'
import { parseDidDocument, type DidDocument, type DidDocumentReason } from './did-document'
import { didToPublicJwk, didJwkVerificationMethod } from '@/utils/did-jwk'
import { ResponseTooLargeError } from './did-web-fetch.adapter'
import type { Clock } from '@/background/ports/ports'

export type DidResolutionReason =
  | DidSyntaxReason
  | DidWebUrlReason
  | DidDocumentReason
  | 'method-not-allowed'
  | 'rate-limited'
  | 'fetch-failed'
  | 'bad-status'
  | 'bad-content-type'
  | 'response-too-large'
  | 'invalid-json'

/** The only failure type this module throws. Carries a machine-readable reason. */
export class DidResolutionError extends Error {
  readonly reason: DidResolutionReason
  readonly did: string

  constructor(reason: DidResolutionReason, did: string) {
    super(`DID resolution failed (${reason})`)
    this.name = 'DidResolutionError'
    this.reason = reason
    this.did = did
  }
}

/**
 * The narrow outbound-HTTP surface a DID resolver needs — deliberately NOT the
 * general `Http` port (`fetch(url, init): Promise<unknown>`). A resolver handed
 * a general fetch could be given any init the caller likes, including
 * `redirect: 'follow'`, and the no-redirect rider would become a convention
 * rather than a constraint. This shape cannot express a redirect policy at all,
 * so the adapter owns it.
 */
export interface DidWebFetch {
  /**
   * GET `url` and return the body as text.
   *
   * The adapter MUST: use HTTPS as given, refuse redirects, apply a timeout,
   * and stop reading past `maxBytes`. It MUST NOT send credentials, cookies, or
   * any ambient authorization.
   */
  getJson(
    url: string,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<{ status: number; contentType: string | null; body: string }>
}

export interface DidResolverOptions {
  /** How long a successfully resolved document stays fresh. Default 5 minutes. */
  ttlMs?: number
  /** Max network resolutions per host per window. Default 10. */
  rateLimitMax?: number
  /** Max network resolutions across ALL hosts per window. Default 30. */
  globalRateLimitMax?: number
  /** Rate-limit window. Default 60s. */
  rateLimitWindowMs?: number
  /** Per-request network timeout. Default 5s. */
  timeoutMs?: number
  /** Max DID document size accepted. Default 64 KiB. */
  maxBytes?: number
  /** Max cached documents; oldest evicted first. Default 128. */
  maxCacheEntries?: number
}

const DEFAULTS = {
  ttlMs: 5 * 60_000,
  rateLimitMax: 10,
  globalRateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  timeoutMs: 5_000,
  maxBytes: 64 * 1024,
  maxCacheEntries: 128,
} as const

/** Methods this resolver knows how to resolve at all. */
export const SUPPORTED_METHODS = ['jwk', 'web'] as const

export interface CounterpartyDidResolver {
  /**
   * Resolve `did` to a validated document.
   *
   * `allowMethods` is per-call and fail-closed: an EMPTY list admits nothing,
   * matching `allowFrom`'s empty-descriptor semantics. A caller that wants
   * everything must say so, because "I forgot to pass a policy" and "I allow
   * every method" must not be the same program.
   *
   * @throws {DidResolutionError} on any failure.
   */
  resolve(did: string, opts: { allowMethods: readonly string[] }): Promise<DidDocument>
}

interface CacheEntry {
  document: DidDocument
  /** When the entry was written. Kept so a BACKWARDS clock jump is detectable. */
  cachedAt: number
  expiresAt: number
}

/** Host of a built did:web URL, used to scope the rate limit. */
function hostOf(url: string): string {
  const withoutScheme = url.slice('https://'.length)
  const slash = withoutScheme.indexOf('/')
  return slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)
}

export function createCounterpartyDidResolver(
  deps: { http: DidWebFetch; clock: Clock },
  options: DidResolverOptions = {},
): CounterpartyDidResolver {
  const cfg = { ...DEFAULTS, ...options }
  const cache = new Map<string, CacheEntry>()
  /** Timestamps of recent network resolutions, pruned to the current window. */
  let recentFetches: number[] = []
  /** Per-host timestamps, so one hostile host cannot spend everyone's budget. */
  const hostFetches = new Map<string, number[]>()
  /**
   * Resolutions currently in flight, keyed by DID.
   *
   * 🩸 Review finding. Without this, two concurrent resolves of the SAME DID
   * issued two fetches and spent two rate-limit tokens for one logical
   * resolution. In an MV3 worker `chrome.runtime.onMessage` handlers run
   * concurrently, so N queued messages meant N fetches.
   */
  const inFlight = new Map<string, Promise<DidDocument>>()

  function readCache(did: string, now: number): DidDocument | null {
    const entry = cache.get(did)
    if (!entry) return null
    // 🩸 A backwards clock jump made `expiresAt` unreachably distant, so a
    // revoked key kept being served for the size of the correction. Treat
    // "written in the future" as expired rather than as fresh.
    if (now >= entry.expiresAt || now < entry.cachedAt) {
      cache.delete(did)
      return null
    }
    return entry.document
  }

  function writeCache(did: string, document: DidDocument, now: number): void {
    // Insertion-ordered eviction: `Map` preserves insertion order, so the first
    // key is the oldest. Re-inserting an existing key would keep its original
    // position, so delete first to make a refresh count as recent.
    cache.delete(did)
    if (cache.size >= cfg.maxCacheEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(did, { document, cachedAt: now, expiresAt: now + cfg.ttlMs })
  }

  /**
   * Per-host budget with a global backstop.
   *
   * 🩸 Review finding. A single global counter, spent BEFORE the fetch and never
   * refunded on failure (failures are deliberately not cached), meant one
   * hostile page could burn the whole budget against a dead host and every
   * honest counterparty was refused for the rest of the window — which dispatch
   * surfaces as `peer-verification-failed`. Demonstrated: 5 failing resolves of
   * one host locked out a never-before-seen host.
   *
   * Per-host is the fix: a hostile host exhausts only its own budget. The global
   * cap stays as a backstop against a page cycling through many hosts, but is
   * set high enough that it is not the binding constraint in normal use.
   *
   * Timestamps ahead of `now` are dropped, not kept: a BACKWARDS clock
   * correction would otherwise leave pre-correction entries in the window
   * forever, locking the host out for window + skew.
   */
  function checkRateLimit(host: string, now: number): boolean {
    const windowStart = now - cfg.rateLimitWindowMs
    const inWindow = (t: number): boolean => t > windowStart && t <= now

    recentFetches = recentFetches.filter(inWindow)
    if (recentFetches.length >= cfg.globalRateLimitMax) return false

    const forHost = (hostFetches.get(host) ?? []).filter(inWindow)
    if (forHost.length >= cfg.rateLimitMax) {
      hostFetches.set(host, forHost)
      return false
    }

    forHost.push(now)
    hostFetches.set(host, forHost)
    recentFetches.push(now)

    // Bound the per-host map so a page cycling hosts cannot grow it without end.
    if (hostFetches.size > cfg.maxCacheEntries) {
      for (const [key, times] of hostFetches) {
        if (times.every((t) => !inWindow(t))) hostFetches.delete(key)
      }
    }
    return true
  }

  /**
   * `did:jwk` resolves from the identifier itself — no network, no cache needed.
   *
   * `didToPublicJwk` JSON-parses attacker-controlled base64url, so its output is
   * untrusted input like any other: it goes through `parseDidDocument`, which
   * validates the JWK shape and the `id`, rather than being returned directly.
   * The existing `resolveDid` helper in `@/utils/did-jwk` is deliberately NOT
   * reused here — it builds the same document but returns it unvalidated.
   */
  function resolveJwk(did: string): DidDocument {
    let jwk: JsonWebKey
    try {
      jwk = didToPublicJwk(did)
    } catch {
      throw new DidResolutionError('invalid-json', did)
    }
    const vm = didJwkVerificationMethod(did)
    const result = parseDidDocument(
      {
        id: did,
        verificationMethod: [
          { id: vm, type: 'JsonWebKey2020', controller: did, publicKeyJwk: jwk },
        ],
        authentication: [vm],
        assertionMethod: [vm],
      },
      did,
    )
    if (!result.ok) throw new DidResolutionError(result.reason, did)
    return result.value
  }

  async function resolveWeb(did: string, methodSpecificId: string, now: number): Promise<DidDocument> {
    const url = buildDidWebUrl(methodSpecificId)
    if (!url.ok) throw new DidResolutionError(url.reason, did)

    if (!checkRateLimit(hostOf(url.value), now)) {
      throw new DidResolutionError('rate-limited', did)
    }

    let response: { status: number; contentType: string | null; body: string }
    try {
      response = await deps.http.getJson(url.value, {
        timeoutMs: cfg.timeoutMs,
        maxBytes: cfg.maxBytes,
      })
    } catch (err) {
      // 🩸 The size abort used to be swallowed into `fetch-failed`, leaving the
      // `response-too-large` branch below UNREACHABLE — the adapter caps the
      // stream, so a returned body can never exceed the cap. Review found the
      // test that "proved" that branch was green only because the fake adapter
      // ignored the `maxBytes` contract the port documents. Distinguishing the
      // adapter's own cap error makes the reason reachable from a
      // contract-honouring adapter.
      if (err instanceof ResponseTooLargeError) {
        throw new DidResolutionError('response-too-large', did)
      }
      // Everything else — redirect refusal, timeout, DNS, connection — stays
      // coarse on purpose: distinguishing them hands a calling page a probe for
      // what is reachable from the user's network.
      throw new DidResolutionError('fetch-failed', did)
    }

    if (response.status !== 200) throw new DidResolutionError('bad-status', did)
    // Defence in depth against an adapter that does not honour the cap. Counted
    // in BYTES: `String.length` is UTF-16 code units, which undercounts
    // multi-byte UTF-8 (review: 455 units / 615 bytes passed a 500 guard).
    if (new TextEncoder().encode(response.body).byteLength > cfg.maxBytes) {
      throw new DidResolutionError('response-too-large', did)
    }

    // A DID document is JSON. Requiring the declared type stops an HTML error
    // page or an intranet portal from being parsed as one on the off chance its
    // body happens to be valid JSON.
    const contentType = (response.contentType ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json' && contentType !== 'application/did+json') {
      throw new DidResolutionError('bad-content-type', did)
    }

    let json: unknown
    try {
      json = JSON.parse(response.body)
    } catch {
      throw new DidResolutionError('invalid-json', did)
    }

    const parsed = parseDidDocument(json, did)
    if (!parsed.ok) throw new DidResolutionError(parsed.reason, did)
    return parsed.value
  }

  return {
    async resolve(did, opts) {
      // 1 — syntax
      const parsed = parseDid(did)
      if (!parsed.ok) throw new DidResolutionError(parsed.reason, typeof did === 'string' ? did : '')
      const { method, methodSpecificId } = parsed.value

      // 2 — allowlist, BEFORE the cache (see the module comment)
      if (!opts.allowMethods.includes(method)) {
        throw new DidResolutionError('method-not-allowed', did)
      }
      if (!SUPPORTED_METHODS.includes(method as (typeof SUPPORTED_METHODS)[number])) {
        throw new DidResolutionError('method-not-allowed', did)
      }

      const now = deps.clock.now()

      // 3 — cache
      const cached = readCache(did, now)
      if (cached) return cached

      // 4/5 — resolve. `jwk` is local and deterministic, so it is neither rate
      // limited nor cached: there is nothing to spend and nothing to stale.
      if (method === 'jwk') return resolveJwk(did)

      // Join an in-flight resolution for the same DID rather than starting a
      // second one. Failures are removed from the map so they are not sticky —
      // this coalesces concurrent work, it is not a negative cache.
      const existing = inFlight.get(did)
      if (existing) return await existing

      const work = (async (): Promise<DidDocument> => {
        const document = await resolveWeb(did, methodSpecificId, now)
        // 7 — cache the validated document. The clock is re-read AFTER the
        // network round-trip: anchoring the TTL to the pre-fetch timestamp gave
        // a 4.5s fetch under a 5s TTL only 500ms of cache life.
        writeCache(did, document, deps.clock.now())
        return document
      })()

      inFlight.set(did, work)
      try {
        return await work
      } finally {
        inFlight.delete(did)
      }
    },
  }
}
