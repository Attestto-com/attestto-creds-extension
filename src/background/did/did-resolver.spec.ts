import { describe, it, expect, vi } from 'vitest'
import {
  createCounterpartyDidResolver,
  DidResolutionError,
  type DidWebFetch,
} from './did-resolver'
import { ResponseTooLargeError } from './did-web-fetch.adapter'
import { publicJwkToDid } from '@/utils/did-jwk'

const DID = 'did:web:id.example.org'
const P256_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
}

function webDoc(id = DID) {
  return {
    id,
    verificationMethod: [
      { id: `${id}#key-1`, type: 'JsonWebKey2020', controller: id, publicKeyJwk: P256_JWK },
    ],
    authentication: [`${id}#key-1`],
    assertionMethod: [`${id}#key-1`],
  }
}

/** A fetch stub that COUNTS calls — the independent referent for cache/rate tests. */
function fakeHttp(
  respond: (url: string) => { status?: number; contentType?: string | null; body?: string } = () => ({}),
) {
  const calls: string[] = []
  const http: DidWebFetch = {
    getJson: vi.fn(async (url: string) => {
      calls.push(url)
      const r = respond(url)
      return {
        status: r.status ?? 200,
        contentType: r.contentType === undefined ? 'application/json' : r.contentType,
        body: r.body ?? JSON.stringify(webDoc()),
      }
    }),
  }
  return { http, calls }
}

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

async function reasonOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof DidResolutionError) return err.reason
    return `unexpected:${String(err)}`
  }
  return 'did-not-throw'
}

describe('resolve — did:web happy path', () => {
  it('fetches the well-known URL and returns the validated document', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })

    const document = await resolver.resolve(DID, { allowMethods: ['web'] })

    expect(calls).toEqual(['https://id.example.org/.well-known/did.json'])
    expect(document.id).toBe(DID)
    expect(document.verificationMethod).toHaveLength(1)
  })

  it('passes the timeout and byte cap down to the adapter', async () => {
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { timeoutMs: 1234, maxBytes: 999 },
    )
    await resolver.resolve(DID, { allowMethods: ['web'] })
    expect(http.getJson).toHaveBeenCalledWith(expect.any(String), {
      timeoutMs: 1234,
      maxBytes: 999,
    })
  })
})

describe('resolve — did:jwk resolves locally', () => {
  const jwkDid = publicJwkToDid(P256_JWK)

  it('returns a document without touching the network', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })

    const document = await resolver.resolve(jwkDid, { allowMethods: ['jwk'] })

    expect(calls).toEqual([])
    expect(document.id).toBe(jwkDid)
    expect(document.verificationMethod[0].publicKeyJwk).toEqual(P256_JWK)
  })

  it('validates the embedded JWK rather than trusting the encoding', async () => {
    // A did:jwk whose body decodes to something that is not a usable public key.
    const bogus = `did:jwk:${btoa(JSON.stringify({ kty: 'RSA', n: 'x' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(bogus, { allowMethods: ['jwk'] }))).toBe(
      'invalid-verification-method',
    )
  })

  it('rejects a did:jwk whose body is not JSON at all', async () => {
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(
      await reasonOf(() => resolver.resolve('did:jwk:not-base64-json', { allowMethods: ['jwk'] })),
    ).toBe('invalid-json')
  })
})

/**
 * 🔒 The allowlist is checked BEFORE the cache. Getting that order wrong means a
 * document cached for one caller is served to a caller whose policy excludes it.
 */
describe('resolve — method allowlist', () => {
  it('refuses a method the caller did not allow', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['jwk'] }))).toBe(
      'method-not-allowed',
    )
    expect(calls).toEqual([])
  })

  it('an EMPTY allowlist admits nothing (fail-closed, like allowFrom)', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: [] }))).toBe(
      'method-not-allowed',
    )
    expect(calls).toEqual([])
  })

  it('refuses a method that is allowed but unsupported', async () => {
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(
      await reasonOf(() =>
        resolver.resolve('did:ion:abc', { allowMethods: ['ion', 'web', 'jwk'] }),
      ),
    ).toBe('method-not-allowed')
  })

  it('does NOT serve a cached document to a caller whose allowlist excludes it', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })

    // Warm the cache under a permissive policy.
    await resolver.resolve(DID, { allowMethods: ['web'] })
    expect(calls).toHaveLength(1)

    // A second caller forbids `web`. If the cache were read first, this would
    // hand back the document anyway.
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['jwk'] }))).toBe(
      'method-not-allowed',
    )
  })
})

describe('resolve — syntax failures propagate their reason', () => {
  it.each([
    ['did:web:example.com#key-1', 'is-a-did-url'],
    ['not-a-did', 'missing-did-prefix'],
    ['did:web:', 'empty-method-specific-id'],
  ])('%s → %s', async (did, reason) => {
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(did, { allowMethods: ['web', 'jwk'] }))).toBe(
      reason,
    )
  })

  it('rejects an SSRF host before any fetch', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(
      await reasonOf(() => resolver.resolve('did:web:169.254.169.254', { allowMethods: ['web'] })),
    ).toBe('ip-literal-host')
    expect(calls).toEqual([])
  })
})

describe('resolve — response validation', () => {
  it.each([
    ['a non-200 status', { status: 404 }, 'bad-status'],
    ['an HTML content-type', { contentType: 'text/html' }, 'bad-content-type'],
    ['a missing content-type', { contentType: null }, 'bad-content-type'],
    ['a non-JSON body', { body: '<html>nope</html>' }, 'invalid-json'],
  ])('rejects %s', async (_label, respond, reason) => {
    const { http } = fakeHttp(() => respond)
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe(reason)
  })

  it('accepts application/did+json with parameters', async () => {
    const { http } = fakeHttp(() => ({ contentType: 'application/did+json; charset=utf-8' }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    await expect(resolver.resolve(DID, { allowMethods: ['web'] })).resolves.toBeTruthy()
  })

  it('🔒 rejects a document describing a DIFFERENT did', async () => {
    // The resolve-then-trust bug: id.example.org answers with evil.example's keys.
    const { http } = fakeHttp(() => ({ body: JSON.stringify(webDoc('did:web:evil.example.org')) }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe(
      'id-mismatch',
    )
  })

  it('surfaces an adapter throw as fetch-failed without leaking which', async () => {
    const http: DidWebFetch = {
      getJson: vi.fn(async () => {
        throw new Error('net::ERR_CONNECTION_REFUSED on 10.0.0.5')
      }),
    }
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    let caught: unknown
    try {
      await resolver.resolve(DID, { allowMethods: ['web'] })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DidResolutionError)
    expect((caught as DidResolutionError).reason).toBe('fetch-failed')
    // A calling page must not learn what is reachable from the user's network.
    expect(String((caught as Error).message)).not.toContain('10.0.0.5')
    expect(String((caught as Error).message)).not.toContain('CONNECTION_REFUSED')
  })

})

/**
 * Cache assertions use the fetch CALL COUNT as the referent — not a `cached`
 * flag the resolver would be reporting about itself.
 */
describe('resolve — TTL cache', () => {
  it('serves a second resolve from cache', async () => {
    const { http, calls } = fakeHttp()
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    await resolver.resolve(DID, { allowMethods: ['web'] })
    await resolver.resolve(DID, { allowMethods: ['web'] })
    expect(calls).toHaveLength(1)
  })

  it('refetches once the TTL has elapsed', async () => {
    const { http, calls } = fakeHttp()
    const clock = fakeClock()
    const resolver = createCounterpartyDidResolver({ http, clock }, { ttlMs: 60_000 })

    await resolver.resolve(DID, { allowMethods: ['web'] })
    clock.advance(59_999)
    await resolver.resolve(DID, { allowMethods: ['web'] })
    expect(calls).toHaveLength(1)

    clock.advance(2)
    await resolver.resolve(DID, { allowMethods: ['web'] })
    expect(calls).toHaveLength(2)
  })

  it('does NOT cache failures — a transient outage must not lock a peer out', async () => {
    let fail = true
    const { http, calls } = fakeHttp(() => (fail ? { status: 503 } : {}))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })

    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe('bad-status')
    fail = false
    const document = await resolver.resolve(DID, { allowMethods: ['web'] })

    expect(document.id).toBe(DID)
    expect(calls).toHaveLength(2)
  })

  /**
   * 🩸 Review finding (medium). With `expiresAt` computed from a pre-jump
   * clock, a backwards correction put expiry unreachably far in the future and
   * the resolver kept serving the OLD document — including after a key was
   * revoked from the source.
   */
  it('🔒 a backwards clock jump does not make a cached document immortal', async () => {
    const revoked = `${DID}#key-1`
    let live = true
    const { http, calls } = fakeHttp(() => ({
      body: JSON.stringify(
        live
          ? webDoc()
          : { id: DID, verificationMethod: [
              { id: revoked, type: 'JsonWebKey2020', controller: DID, publicKeyJwk: P256_JWK },
            ], authentication: [], assertionMethod: [] },
      ),
    }))
    const clock = fakeClock()
    const resolver = createCounterpartyDidResolver({ http, clock }, { ttlMs: 60_000 })

    const first = await resolver.resolve(DID, { allowMethods: ['web'] })
    expect(first.authentication).toEqual([revoked])
    expect(calls).toHaveLength(1)

    // The key is revoked at the source, then the clock steps back a day.
    live = false
    clock.advance(-86_400_000)
    clock.advance(600_000) // ten minutes later by the new clock

    const second = await resolver.resolve(DID, { allowMethods: ['web'] })
    // It must have refetched and seen the revocation, not served the stale doc.
    expect(calls).toHaveLength(2)
    expect(second.authentication).toEqual([])
  })

  it('caches per DID, not globally', async () => {
    const other = 'did:web:other.example.org'
    const { http, calls } = fakeHttp((url) => ({
      body: JSON.stringify(webDoc(url.includes('other') ? other : DID)),
    }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    await resolver.resolve(DID, { allowMethods: ['web'] })
    await resolver.resolve(other, { allowMethods: ['web'] })
    expect(calls).toHaveLength(2)
  })

  it('evicts the oldest entry past the cap', async () => {
    const { http, calls } = fakeHttp((url) => {
      const host = new URL(url).hostname
      return { body: JSON.stringify(webDoc(`did:web:${host}`)) }
    })
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { maxCacheEntries: 2 },
    )
    await resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] })
    await resolver.resolve('did:web:b.example.org', { allowMethods: ['web'] })
    await resolver.resolve('did:web:c.example.org', { allowMethods: ['web'] })
    expect(calls).toHaveLength(3)

    // `a` was evicted → refetch. `c` is still resident → no refetch.
    await resolver.resolve('did:web:c.example.org', { allowMethods: ['web'] })
    expect(calls).toHaveLength(3)
    await resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] })
    expect(calls).toHaveLength(4)
  })
})

/**
 * Without a limiter, any page that can trigger resolution turns the service
 * worker into a request generator pointed wherever it likes.
 */
describe('resolve — rate limit', () => {
  /** Each DID gets its own host, and the doc echoes the host so `id` matches. */
  function hostEcho() {
    return fakeHttp((url) => ({
      body: JSON.stringify(webDoc(`did:web:${new URL(url).hostname}`)),
    }))
  }

  it('stops fetching once a host has spent its budget', async () => {
    const { http, calls } = hostEcho()
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 3, rateLimitWindowMs: 60_000, ttlMs: 0, maxCacheEntries: 100 },
    )
    // ttlMs 0 → every call is a miss, so the budget is what stops it.
    for (let i = 0; i < 3; i++) {
      await resolver.resolve('did:web:h.example.org', { allowMethods: ['web'] })
    }
    expect(calls).toHaveLength(3)

    expect(
      await reasonOf(() => resolver.resolve('did:web:h.example.org', { allowMethods: ['web'] })),
    ).toBe('rate-limited')
    expect(calls).toHaveLength(3)
  })

  /**
   * 🩸 Review finding (medium). The budget was a single global counter, spent
   * before the fetch and never refunded, and failures are deliberately not
   * cached — so a page hammering one dead host locked out every honest
   * counterparty for the rest of the window, which dispatch reports as
   * `peer-verification-failed`.
   */
  it('🔒 a hostile host cannot spend an honest host budget', async () => {
    let failing = true
    const { http } = fakeHttp((url) => {
      const host = new URL(url).hostname
      if (host.startsWith('evil') && failing) return { status: 503 }
      return { body: JSON.stringify(webDoc(`did:web:${host}`)) }
    })
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 5, globalRateLimitMax: 100, rateLimitWindowMs: 60_000, ttlMs: 0 },
    )

    // Burn the hostile host's entire budget.
    for (let i = 0; i < 5; i++) {
      expect(
        await reasonOf(() => resolver.resolve('did:web:evil.example.org', { allowMethods: ['web'] })),
      ).toBe('bad-status')
    }
    // It is now locked out...
    expect(
      await reasonOf(() => resolver.resolve('did:web:evil.example.org', { allowMethods: ['web'] })),
    ).toBe('rate-limited')

    // ...but a host that has never been resolved still works.
    failing = false
    const document = await resolver.resolve('did:web:honest.example.org', {
      allowMethods: ['web'],
    })
    expect(document.id).toBe('did:web:honest.example.org')
  })

  it('the global cap still backstops a page cycling through many hosts', async () => {
    const { http, calls } = hostEcho()
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 5, globalRateLimitMax: 3, rateLimitWindowMs: 60_000, maxCacheEntries: 100 },
    )
    for (let i = 0; i < 3; i++) {
      await resolver.resolve(`did:web:h${i}.example.org`, { allowMethods: ['web'] })
    }
    expect(calls).toHaveLength(3)
    expect(
      await reasonOf(() => resolver.resolve('did:web:h9.example.org', { allowMethods: ['web'] })),
    ).toBe('rate-limited')
  })

  it('refills once the window rolls over', async () => {
    const clock = fakeClock()
    const { http, calls } = hostEcho()
    const resolver = createCounterpartyDidResolver(
      { http, clock },
      { rateLimitMax: 1, rateLimitWindowMs: 60_000, ttlMs: 0, maxCacheEntries: 100 },
    )

    await resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] })
    expect(
      await reasonOf(() => resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] })),
    ).toBe('rate-limited')

    clock.advance(60_001)
    await resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] })
    expect(calls).toHaveLength(2)
  })

  /**
   * 🩸 Review finding. A backwards NTP correction left pre-correction
   * timestamps in the window until the clock caught up, locking the host out
   * for window + skew.
   */
  it('a backwards clock jump does not lock a host out', async () => {
    const clock = fakeClock()
    const { http } = hostEcho()
    const resolver = createCounterpartyDidResolver(
      { http, clock },
      { rateLimitMax: 1, rateLimitWindowMs: 60_000, ttlMs: 0 },
    )
    await resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] })
    clock.advance(-3_600_000) // NTP steps back an hour
    clock.advance(61_000)
    await expect(
      resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] }),
    ).resolves.toBeTruthy()
  })

  it('a cache hit does not spend budget', async () => {
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 1 },
    )
    await resolver.resolve(DID, { allowMethods: ['web'] })
    // Second call is cached; if it spent budget this would be `rate-limited`.
    await expect(resolver.resolve(DID, { allowMethods: ['web'] })).resolves.toBeTruthy()
  })

  it('did:jwk does not spend budget (no network to spend)', async () => {
    const jwkDid = publicJwkToDid(P256_JWK)
    const { http } = fakeHttp()
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 1 },
    )
    for (let i = 0; i < 5; i++) {
      await resolver.resolve(jwkDid, { allowMethods: ['jwk'] })
    }
    // The one web budget unit is still unspent.
    await expect(resolver.resolve(DID, { allowMethods: ['web'] })).resolves.toBeTruthy()
  })
})

/**
 * 🩸 Review finding (medium). MV3 runs `chrome.runtime.onMessage` handlers
 * concurrently, so N queued messages naming the same DID produced N fetches and
 * spent N rate-limit tokens for one logical resolution.
 */
describe('resolve — concurrent resolutions of the same DID coalesce', () => {
  it('issues ONE fetch for simultaneous resolves of the same DID', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => (release = r))
    const calls: string[] = []
    const http: DidWebFetch = {
      getJson: vi.fn(async (url: string) => {
        calls.push(url)
        await gate
        return { status: 200, contentType: 'application/json', body: JSON.stringify(webDoc()) }
      }),
    }
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })

    const both = Promise.all([
      resolver.resolve(DID, { allowMethods: ['web'] }),
      resolver.resolve(DID, { allowMethods: ['web'] }),
    ])
    release?.()
    const [a, b] = await both

    expect(calls).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('does not spend two rate-limit tokens for one logical resolution', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => (release = r))
    const http: DidWebFetch = {
      getJson: vi.fn(async (url: string) => {
        await gate
        const host = new URL(url).hostname
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(webDoc(`did:web:${host}`)),
        }
      }),
    }
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 2, globalRateLimitMax: 2, ttlMs: 0 },
    )
    const both = Promise.all([
      resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] }),
      resolver.resolve('did:web:a.example.org', { allowMethods: ['web'] }),
    ])
    release?.()
    await both

    // One token spent, so a different host still resolves.
    await expect(
      resolver.resolve('did:web:b.example.org', { allowMethods: ['web'] }),
    ).resolves.toBeTruthy()
  })

  it('a failed in-flight resolution is not sticky', async () => {
    let fail = true
    const { http, calls } = fakeHttp(() => (fail ? { status: 503 } : {}))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })

    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe('bad-status')
    fail = false
    await expect(resolver.resolve(DID, { allowMethods: ['web'] })).resolves.toBeTruthy()
    expect(calls).toHaveLength(2)
  })
})

/**
 * 🩸 Review finding. `response-too-large` was UNREACHABLE: the adapter caps the
 * stream, so a returned body can never exceed the cap, and the adapter's throw
 * was swallowed into `fetch-failed`. The test that "proved" the branch was green
 * only because the fake ignored the `maxBytes` contract the port documents.
 */
describe('resolve — the size cap is reachable from a contract-honouring adapter', () => {
  it('maps the adapter cap error to response-too-large', async () => {
    const http: DidWebFetch = {
      getJson: vi.fn(async () => {
        // What the real adapter does when the stream passes the cap.
        throw new ResponseTooLargeError()
      }),
    }
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe(
      'response-too-large',
    )
  })

  it('counts BYTES, not UTF-16 code units, in the defensive check', async () => {
    // 200 astral characters = 400 UTF-16 units but 800 UTF-8 bytes. A
    // `String.length` guard at 500 would have let this through.
    const { http } = fakeHttp(() => ({ body: '𝄞'.repeat(200) }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() }, { maxBytes: 500 })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe(
      'response-too-large',
    )
  })

  it('still distinguishes an ordinary failure from a size failure', async () => {
    const http: DidWebFetch = {
      getJson: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    }
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe(
      'fetch-failed',
    )
  })
})

describe('resolve — fail-closed shape', () => {
  it('never resolves to null or a partial document', async () => {
    const { http } = fakeHttp(() => ({ status: 500 }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    // The CORTEX `detokenize` lesson: a read that degrades gracefully is a
    // defect on a decision path. This one throws or returns a whole document.
    await expect(resolver.resolve(DID, { allowMethods: ['web'] })).rejects.toBeInstanceOf(
      DidResolutionError,
    )
  })

  it('carries the requested DID on the error for diagnosis', async () => {
    const { http } = fakeHttp(() => ({ status: 500 }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() })
    try {
      await resolver.resolve(DID, { allowMethods: ['web'] })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as DidResolutionError).did).toBe(DID)
    }
  })
})
