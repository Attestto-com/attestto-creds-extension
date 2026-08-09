import { describe, it, expect, vi } from 'vitest'
import { createDidWebFetch, ResponseTooLargeError, type FetchLike } from './did-web-fetch.adapter'

function bodyOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function response(
  text: string,
  init: { status?: number; contentType?: string | null } = {},
): Response {
  const headers = new Headers()
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
  return new Response(bodyOf(text), { status: init.status ?? 200, headers })
}

describe('createDidWebFetch — the transport riders', () => {
  /**
   * 🔒 The single most load-bearing line. `did-web-url.ts` validates the host of
   * the URL we BUILD; a followed redirect means the browser loads a different
   * one, and every host check above it becomes decorative.
   */
  it('refuses redirects', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => response('{}'))
    await createDidWebFetch({ fetch: fetchSpy }).getJson('https://a.example/did.json', {
      timeoutMs: 1000,
      maxBytes: 1024,
    })
    expect(fetchSpy.mock.calls[0][1].redirect).toBe('error')
  })

  it('sends no credentials and no referrer', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => response('{}'))
    await createDidWebFetch({ fetch: fetchSpy }).getJson('https://a.example/did.json', {
      timeoutMs: 1000,
      maxBytes: 1024,
    })
    const init = fetchSpy.mock.calls[0][1]
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
  })

  it('bypasses the HTTP cache so the resolver owns TTL', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => response('{}'))
    await createDidWebFetch({ fetch: fetchSpy }).getJson('https://a.example/did.json', {
      timeoutMs: 1000,
      maxBytes: 1024,
    })
    expect(fetchSpy.mock.calls[0][1].cache).toBe('no-store')
  })

  it('uses GET and passes an abort signal', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => response('{}'))
    await createDidWebFetch({ fetch: fetchSpy }).getJson('https://a.example/did.json', {
      timeoutMs: 1000,
      maxBytes: 1024,
    })
    const init = fetchSpy.mock.calls[0][1]
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('fetches exactly the URL it was given, unmodified', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => response('{}'))
    await createDidWebFetch({ fetch: fetchSpy }).getJson(
      'https://id.example.org/users/alice/did.json',
      { timeoutMs: 1000, maxBytes: 1024 },
    )
    expect(fetchSpy.mock.calls[0][0]).toBe('https://id.example.org/users/alice/did.json')
  })
})

describe('createDidWebFetch — timeout', () => {
  it('aborts the signal once the timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      let captured: AbortSignal | undefined
      const fetchSpy = vi.fn<FetchLike>(async (_url, init) => {
        captured = init.signal as AbortSignal
        // Never settles until the signal fires — a hung server.
        return await new Promise<Response>((_resolve, reject) => {
          captured?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      })

      const promise = createDidWebFetch({ fetch: fetchSpy })
        .getJson('https://a.example/did.json', { timeoutMs: 5000, maxBytes: 1024 })
        .catch((err: unknown) => err)

      expect(captured?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(captured?.aborted).toBe(true)
      expect(await promise).toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the timer on success so the worker is not held awake', async () => {
    vi.useFakeTimers()
    try {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
      await createDidWebFetch({ fetch: async () => response('{}') }).getJson(
        'https://a.example/did.json',
        { timeoutMs: 5000, maxBytes: 1024 },
      )
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The cap must stop READING, not check a length afterwards. `await res.text()`
 * on a multi-gigabyte body is an out-of-memory before any check could run.
 */
describe('createDidWebFetch — byte cap', () => {
  it('throws once the body passes the cap', async () => {
    const big = 'x'.repeat(5000)
    await expect(
      createDidWebFetch({ fetch: async () => response(big) }).getJson(
        'https://a.example/did.json',
        { timeoutMs: 1000, maxBytes: 100 },
      ),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('stops pulling chunks instead of draining the whole stream', async () => {
    // The independent referent: how many chunks the producer was asked for. A
    // post-hoc length check would pull all 100.
    let chunksProduced = 0
    const streaming = new Response(
      new ReadableStream({
        pull(controller) {
          chunksProduced++
          if (chunksProduced > 100) {
            controller.close()
            return
          }
          controller.enqueue(new TextEncoder().encode('y'.repeat(50)))
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    )

    await expect(
      createDidWebFetch({ fetch: async () => streaming }).getJson('https://a.example/did.json', {
        timeoutMs: 1000,
        maxBytes: 100,
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)

    // 100 bytes / 50-byte chunks = the cap trips on chunk 3, not chunk 100.
    expect(chunksProduced).toBeLessThan(10)
  })

  it('accepts a body exactly at the cap', async () => {
    const exact = 'z'.repeat(100)
    const result = await createDidWebFetch({ fetch: async () => response(exact) }).getJson(
      'https://a.example/did.json',
      { timeoutMs: 1000, maxBytes: 100 },
    )
    expect(result.body).toBe(exact)
  })
})

describe('createDidWebFetch — response passthrough', () => {
  it('returns status, content-type and body', async () => {
    const result = await createDidWebFetch({
      fetch: async () => response('{"id":"did:web:a.example"}', { contentType: 'application/did+json' }),
    }).getJson('https://a.example/did.json', { timeoutMs: 1000, maxBytes: 1024 })

    expect(result).toEqual({
      status: 200,
      contentType: 'application/did+json',
      body: '{"id":"did:web:a.example"}',
    })
  })

  it('reports a non-200 status rather than throwing', async () => {
    const result = await createDidWebFetch({
      fetch: async () => response('nope', { status: 404 }),
    }).getJson('https://a.example/did.json', { timeoutMs: 1000, maxBytes: 1024 })
    expect(result.status).toBe(404)
  })

  it('reports a null content-type when the header is absent', async () => {
    const result = await createDidWebFetch({
      fetch: async () => response('{}', { contentType: null }),
    }).getJson('https://a.example/did.json', { timeoutMs: 1000, maxBytes: 1024 })
    expect(result.contentType).toBeNull()
  })

  it('handles an empty body', async () => {
    const result = await createDidWebFetch({
      fetch: async () => new Response(null, { status: 204 }),
    }).getJson('https://a.example/did.json', { timeoutMs: 1000, maxBytes: 1024 })
    expect(result.body).toBe('')
  })
})
