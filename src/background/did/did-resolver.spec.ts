import { describe, it, expect, vi } from 'vitest'
import {
  createCounterpartyDidResolver,
  DidResolutionError,
  type DidWebFetch,
} from './did-resolver'
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
    const { http } = fakeHttp(() => ({ body: JSON.stringify(webDoc('did:web:evil.example')) }))
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

  it('rejects a body over the byte cap', async () => {
    const { http } = fakeHttp(() => ({ body: 'x'.repeat(200) }))
    const resolver = createCounterpartyDidResolver({ http, clock: fakeClock() }, { maxBytes: 100 })
    expect(await reasonOf(() => resolver.resolve(DID, { allowMethods: ['web'] }))).toBe(
      'response-too-large',
    )
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

  it('caches per DID, not globally', async () => {
    const other = 'did:web:other.example'
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
    await resolver.resolve('did:web:a.example', { allowMethods: ['web'] })
    await resolver.resolve('did:web:b.example', { allowMethods: ['web'] })
    await resolver.resolve('did:web:c.example', { allowMethods: ['web'] })
    expect(calls).toHaveLength(3)

    // `a` was evicted → refetch. `c` is still resident → no refetch.
    await resolver.resolve('did:web:c.example', { allowMethods: ['web'] })
    expect(calls).toHaveLength(3)
    await resolver.resolve('did:web:a.example', { allowMethods: ['web'] })
    expect(calls).toHaveLength(4)
  })
})

/**
 * Without a limiter, any page that can trigger resolution turns the service
 * worker into a request generator pointed wherever it likes.
 */
describe('resolve — rate limit', () => {
  it('stops fetching once the window budget is spent', async () => {
    const { http, calls } = fakeHttp((url) => ({
      body: JSON.stringify(webDoc(`did:web:${new URL(url).hostname}`)),
    }))
    const resolver = createCounterpartyDidResolver(
      { http, clock: fakeClock() },
      { rateLimitMax: 3, rateLimitWindowMs: 60_000, maxCacheEntries: 100 },
    )

    for (let i = 0; i < 3; i++) {
      await resolver.resolve(`did:web:h${i}.example`, { allowMethods: ['web'] })
    }
    expect(calls).toHaveLength(3)

    expect(
      await reasonOf(() => resolver.resolve('did:web:h3.example', { allowMethods: ['web'] })),
    ).toBe('rate-limited')
    expect(calls).toHaveLength(3)
  })

  it('refills once the window rolls over', async () => {
    const clock = fakeClock()
    const { http, calls } = fakeHttp((url) => ({
      body: JSON.stringify(webDoc(`did:web:${new URL(url).hostname}`)),
    }))
    const resolver = createCounterpartyDidResolver(
      { http, clock },
      { rateLimitMax: 1, rateLimitWindowMs: 60_000, maxCacheEntries: 100 },
    )

    await resolver.resolve('did:web:a.example', { allowMethods: ['web'] })
    expect(
      await reasonOf(() => resolver.resolve('did:web:b.example', { allowMethods: ['web'] })),
    ).toBe('rate-limited')

    clock.advance(60_001)
    await resolver.resolve('did:web:b.example', { allowMethods: ['web'] })
    expect(calls).toHaveLength(2)
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
