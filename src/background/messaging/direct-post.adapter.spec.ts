import { describe, it, expect, vi } from 'vitest'
import { createDirectPost, type FetchLike } from './direct-post.adapter'

function ack(status = 200): Response {
  return new Response(new TextEncoder().encode('{"ok":true}'), { status })
}

const URI = 'https://verifier.example.org/present'
const BODY = { vp_token: 'eyJ.SIGNED.TOKEN', presentation_submission: { id: 'sub-1' }, state: 's' }

describe('createDirectPost — the riders', () => {
  /**
   * 🔒 The load-bearing one. response_uri was bound to the verifier's authority
   * at parse time; a followed redirect re-POSTs the presentation to a target
   * that binding never saw, AFTER the user approved a screen naming someone
   * else.
   */
  it('refuses redirects', async () => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await createDirectPost({ fetch: spy }).post(URI, BODY)
    expect(spy.mock.calls[0][1].redirect).toBe('error')
  })

  it('sends no credentials, no referrer, and bypasses the cache', async () => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await createDirectPost({ fetch: spy }).post(URI, BODY)
    const init = spy.mock.calls[0][1]
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.cache).toBe('no-store')
  })

  it('POSTs form-encoded to exactly the given URI', async () => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await createDirectPost({ fetch: spy }).post(URI, BODY)
    expect(spy.mock.calls[0][0]).toBe(URI)
    expect(spy.mock.calls[0][1].method).toBe('POST')
    expect((spy.mock.calls[0][1].headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
  })

  it('serializes the token and the submission into the form body', async () => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await createDirectPost({ fetch: spy }).post(URI, BODY)
    const form = new URLSearchParams(spy.mock.calls[0][1].body as string)
    expect(form.get('vp_token')).toBe('eyJ.SIGNED.TOKEN')
    expect(JSON.parse(form.get('presentation_submission')!)).toEqual({ id: 'sub-1' })
    expect(form.get('state')).toBe('s')
  })

  it('omits an absent state rather than sending "undefined"', async () => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await createDirectPost({ fetch: spy }).post(URI, { vp_token: 't', state: undefined })
    const form = new URLSearchParams(spy.mock.calls[0][1].body as string)
    expect(form.has('state')).toBe(false)
    expect(spy.mock.calls[0][1].body).not.toContain('undefined')
  })
})

/**
 * The parser owns the real guarantee; this is the last line for a caller that
 * bypassed it. Credential material must never leave over plaintext.
 */
describe('createDirectPost — https only', () => {
  it.each([
    'http://verifier.example.org/present',
    'ftp://verifier.example.org/x',
    'javascript:alert(1)',
    'data:text/plain,x',
  ])('refuses to post to %j', async (uri) => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await expect(createDirectPost({ fetch: spy }).post(uri, BODY)).rejects.toThrow()
    // The independent referent: no request was made at all.
    expect(spy).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: an https URI does reach fetch', async () => {
    const spy = vi.fn<FetchLike>(async () => ack())
    await createDirectPost({ fetch: spy }).post(URI, BODY)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('createDirectPost — the verifier response', () => {
  it('reports a 2xx as ok', async () => {
    const result = await createDirectPost({ fetch: async () => ack(204) }).post(URI, BODY)
    expect(result).toEqual({ ok: true, status: 204 })
  })

  it.each([301, 400, 401, 500])('reports %i as not ok', async (status) => {
    const result = await createDirectPost({ fetch: async () => ack(status) }).post(URI, BODY)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(status)
  })

  it('does not parse or return the verifier body', async () => {
    // A verifier reply is not somewhere we take instructions from.
    const hostile = new Response(
      new TextEncoder().encode('{"instruction":"DISCLOSE-EVERYTHING"}'),
      { status: 200 },
    )
    const result = await createDirectPost({ fetch: async () => hostile }).post(URI, BODY)
    expect(JSON.stringify(result)).not.toContain('DISCLOSE-EVERYTHING')
    expect(Object.keys(result).sort()).toEqual(['ok', 'status'])
  })

  it('stops reading an oversized ack instead of buffering it', async () => {
    let chunks = 0
    const flood = new Response(
      new ReadableStream({
        pull(controller) {
          chunks++
          if (chunks > 200) {
            controller.close()
            return
          }
          controller.enqueue(new Uint8Array(1024))
        },
      }),
      { status: 200 },
    )
    const result = await createDirectPost({ fetch: async () => flood }).post(URI, BODY)
    expect(result.ok).toBe(true)
    expect(chunks).toBeLessThan(20) // 4 KiB cap over 1 KiB chunks
  })

  it('clears the timeout on success', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await createDirectPost({ fetch: async () => ack() }).post(URI, BODY)
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('clears the timeout when the fetch throws', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await expect(
      createDirectPost({
        fetch: async () => {
          throw new Error('network')
        },
      }).post(URI, BODY),
    ).rejects.toThrow()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
