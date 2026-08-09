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
  /** Max network resolutions per window. Default 30. */
  rateLimitMax?: number
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
  rateLimitMax: 30,
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
  expiresAt: number
}

export function createCounterpartyDidResolver(
  deps: { http: DidWebFetch; clock: Clock },
  options: DidResolverOptions = {},
): CounterpartyDidResolver {
  const cfg = { ...DEFAULTS, ...options }
  const cache = new Map<string, CacheEntry>()
  /** Timestamps of recent network resolutions, pruned to the current window. */
  let recentFetches: number[] = []

  function readCache(did: string, now: number): DidDocument | null {
    const entry = cache.get(did)
    if (!entry) return null
    if (now >= entry.expiresAt) {
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
    cache.set(did, { document, expiresAt: now + cfg.ttlMs })
  }

  function checkRateLimit(now: number): boolean {
    const windowStart = now - cfg.rateLimitWindowMs
    recentFetches = recentFetches.filter((t) => t > windowStart)
    if (recentFetches.length >= cfg.rateLimitMax) return false
    recentFetches.push(now)
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

    if (!checkRateLimit(now)) throw new DidResolutionError('rate-limited', did)

    let response: { status: number; contentType: string | null; body: string }
    try {
      response = await deps.http.getJson(url.value, {
        timeoutMs: cfg.timeoutMs,
        maxBytes: cfg.maxBytes,
      })
    } catch {
      // Includes the adapter's redirect refusal, timeout, and size abort. The
      // reason is deliberately coarse: distinguishing them here would hand a
      // calling page a probe for what is reachable from the user's network.
      throw new DidResolutionError('fetch-failed', did)
    }

    if (response.status !== 200) throw new DidResolutionError('bad-status', did)
    if (response.body.length > cfg.maxBytes) throw new DidResolutionError('response-too-large', did)

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

      const document = await resolveWeb(did, methodSpecificId, now)

      // 7 — cache the validated document only
      writeCache(did, document, now)
      return document
    },
  }
}
