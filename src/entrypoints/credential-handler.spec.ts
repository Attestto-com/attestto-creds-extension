/**
 * credential-handler.content.ts — the MAIN-world script, at 0% coverage.
 *
 * This one is different from the other entrypoints, and the difference is the
 * reason to test it: it monkey-patches `navigator.credentials.get` in the
 * page's own JavaScript context, on every https site the user visits.
 *
 * So the highest-consequence behaviour in the file is not any of its features.
 * It is the FALLTHROUGH — that a request which is not ours reaches the browser's
 * original implementation, unchanged. Get that wrong and the extension breaks
 * passkey sign-in on every site on the internet, silently, for everyone who has
 * it installed. Nothing asserted it.
 *
 * ── What is deliberately NOT claimed here ─────────────────────────────────
 *
 * MAIN world means the page shares this JavaScript context. A script on the
 * page can forge any of these events, read every response, and replace the
 * override outright. That is inherent to the protocol, not a defect: the
 * verifier is remote and checks a signature, so a locally forged auth response
 * buys an attacker nothing. These tests therefore assert PROTOCOL CONTRACT and
 * non-interference, not secrecy or authenticity — claiming otherwise would be
 * writing a security test that proves nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const PAGE_ORIGIN = 'https://site.example'

interface Booted {
  posted: Array<[Record<string, unknown>, string]>
  originalGet: ReturnType<typeof vi.fn>
  /** Reply as the ISOLATED content script would. */
  reply: (data: Record<string, unknown>) => void
}

/**
 * Listeners the script registers on the shared `window`. Each test boots the
 * module again, and happy-dom's window survives between tests — so without
 * this, boot N leaves N-1 earlier copies of every handler attached and a single
 * discovery event produces N announcements. The first version of this file
 * "passed" its way to eight.
 */
const registered: Array<[string, EventListenerOrEventListenerObject]> = []

async function bootMainWorld(opts: { withOriginalGet?: boolean } = {}): Promise<Booted> {
  const { withOriginalGet = true } = opts
  const posted: Array<[Record<string, unknown>, string]> = []
  const messageListeners: Array<(e: MessageEvent) => void> = []

  vi.stubGlobal('defineContentScript', (def: { main: () => void }) => def)

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: PAGE_ORIGIN, href: `${PAGE_ORIGIN}/page` },
  })

  // Capture postMessage rather than letting happy-dom deliver it, so the test
  // controls when — and whether — a reply arrives.
  const realAdd = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    fn: EventListenerOrEventListenerObject,
    ...rest: unknown[]
  ) => {
    if (type === 'message') messageListeners.push(fn as (e: MessageEvent) => void)
    registered.push([type, fn])
    ;(realAdd as (...a: unknown[]) => void)(type, fn, ...rest)
  }))

  vi.spyOn(window, 'postMessage').mockImplementation(((data: unknown, target: string) => {
    posted.push([data as Record<string, unknown>, target])
  }) as typeof window.postMessage)

  const originalGet = vi.fn(async () => ({ id: 'browser-credential' }) as unknown as Credential)
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    writable: true,
    value: withOriginalGet ? { get: originalGet } : {},
  })

  const mod = (await import('@/entrypoints/credential-handler.content')) as unknown as {
    default: { main: () => void }
  }
  mod.default.main()

  return {
    posted,
    originalGet,
    reply: (data) => {
      for (const fn of messageListeners) {
        fn({ data, source: window, origin: PAGE_ORIGIN } as unknown as MessageEvent)
      }
    },
  }
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  // Before restoring the spy, detach everything this boot attached: the spy is
  // what recorded them, and the window outlives the test.
  for (const [type, fn] of registered.splice(0)) window.removeEventListener(type, fn)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('navigator.credentials.get — every site on the internet depends on this', () => {
  it('a plain WebAuthn request reaches the browser untouched', () => {
    // The one that matters. A passkey login uses `publicKey` with no Attestto
    // extension; if the override swallowed it, sign-in breaks everywhere the
    // extension is installed and the cause would look like a browser bug.
    return bootMainWorld().then(async ({ originalGet }) => {
      const options = {
        publicKey: { challenge: new Uint8Array([1, 2, 3]), rpId: 'site.example' },
      } as unknown as CredentialRequestOptions

      const result = await navigator.credentials.get(options)

      expect(originalGet).toHaveBeenCalledTimes(1)
      // The SAME object, not a reconstruction: rebuilding the options would
      // drop fields the browser needs and the loss would be invisible here.
      expect(originalGet.mock.calls[0][0]).toBe(options)
      expect(result).toEqual({ id: 'browser-credential' })
    })
  })

  it('an empty request reaches the browser untouched', async () => {
    const { originalGet } = await bootMainWorld()
    await navigator.credentials.get(undefined)
    expect(originalGet).toHaveBeenCalledTimes(1)
  })

  it('a publicKey request with unrelated extensions still reaches the browser', async () => {
    const { originalGet } = await bootMainWorld()
    await navigator.credentials.get({
      publicKey: { challenge: new Uint8Array(), extensions: { appid: 'https://x' } },
    })
    expect(originalGet).toHaveBeenCalledTimes(1)
  })

  it('a browser with no credentials.get is left alone rather than crashed', async () => {
    // `document_start` on every https page, including ones where the API is
    // absent or already replaced. Throwing here would surface as the extension
    // breaking the page.
    await expect(bootMainWorld({ withOriginalGet: false })).resolves.toBeTruthy()
  })
})

describe('CHAPI interception', () => {
  it('a VerifiablePresentation request is relayed, not passed to the browser', async () => {
    const { posted, originalGet } = await bootMainWorld()
    void navigator.credentials.get({
      web: { VerifiablePresentation: { challenge: 'chal', domain: 'https://verifier.example' } },
    } as unknown as CredentialRequestOptions)

    expect(originalGet).not.toHaveBeenCalled()
    const [msg, target] = posted.at(-1)!
    expect(msg.type).toBe('ATTESTTO_VP_REQUEST')
    expect((msg.payload as Record<string, unknown>).protocol).toBe('chapi')
    // Never a wildcard: the relay carries the request to the ISOLATED script in
    // this same page, and nowhere else.
    expect(target).toBe(PAGE_ORIGIN)
  })

  it('resolves with the presentation when the reply correlates', async () => {
    const { posted, reply } = await bootMainWorld()
    const promise = navigator.credentials.get({
      web: { VerifiablePresentation: { challenge: 'chal' } },
    } as unknown as CredentialRequestOptions)

    const requestId = posted.at(-1)![0].requestId
    reply({ type: 'ATTESTTO_VP_RESPONSE', requestId, presentation: { vp: true } })

    await expect(promise).resolves.toMatchObject({
      type: 'web',
      dataType: 'VerifiablePresentation',
      data: { vp: true },
    })
  })

  it('a reply with someone else\'s requestId does not resolve it', async () => {
    // Correlation is the whole reason `requestId` exists. Two overlapping
    // `get()` calls on one page must not be able to answer each other, and a
    // stale reply from an earlier request must not settle a later one.
    vi.useFakeTimers()
    const { reply } = await bootMainWorld()
    const promise = navigator.credentials.get({
      web: { VerifiablePresentation: { challenge: 'chal' } },
    } as unknown as CredentialRequestOptions)
    const settled = vi.fn()
    promise.then(settled, settled)

    reply({ type: 'ATTESTTO_VP_RESPONSE', requestId: 'someone-else', presentation: { vp: true } })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    // And it still times out rather than hanging forever — an unsettled promise
    // from a page API leaks the listener and the caller's await.
    vi.advanceTimersByTime(300_000)
    await expect(promise).rejects.toThrow(/did not respond/i)
  })
})

describe('wallet discovery', () => {
  it('announces this wallet with the nonce it was asked with', async () => {
    await bootMainWorld()
    const announced: unknown[] = []
    window.addEventListener('credential-wallet:announce', (e) =>
      announced.push((e as CustomEvent).detail),
    )

    window.dispatchEvent(
      new CustomEvent('credential-wallet:discover', { detail: { nonce: 'n-1' } }),
    )

    expect(announced).toHaveLength(1)
    const detail = announced[0] as { nonce: string; wallet: { did: string; icon: string } }
    expect(detail.nonce).toBe('n-1')
    expect(detail.wallet.did).toBe('did:web:attestto.com:wallets:attestto-creds')
  })

  it('a discovery event with no nonce is ignored', async () => {
    // Without the nonce there is nothing to correlate the announcement to, so
    // answering would just be noise on the page's event bus.
    await bootMainWorld()
    const announced: unknown[] = []
    window.addEventListener('credential-wallet:announce', () => announced.push(1))
    window.dispatchEvent(new CustomEvent('credential-wallet:discover', { detail: {} }))
    expect(announced).toEqual([])
  })
})

describe('auth relay', () => {
  const authEvent = (detail: Record<string, unknown>) =>
    window.dispatchEvent(new CustomEvent('credential-wallet:auth', { detail }))

  it('relays a well-formed request to the ISOLATED script', async () => {
    const { posted } = await bootMainWorld()
    authEvent({ nonce: 'env-1', request: { nonce: 'sign-me', audience: 'https://verifier.example' } })

    const [msg, target] = posted.at(-1)!
    expect(msg.type).toBe('ATTESTTO_CW_AUTH_REQUEST')
    expect(msg.requestId).toBe('env-1')
    expect(msg.nonce).toBe('sign-me')
    expect(target).toBe(PAGE_ORIGIN)
  })

  it('ignores a request aimed at a different wallet', async () => {
    // A page may have several wallets listening on the same event bus. Answering
    // for another wallet's DID would put this wallet in a flow the user chose
    // somebody else for.
    const { posted } = await bootMainWorld()
    authEvent({
      nonce: 'env-1',
      walletDid: 'did:web:other-wallet.example',
      request: { nonce: 'sign-me' },
    })
    expect(posted.filter(([m]) => m.type === 'ATTESTTO_CW_AUTH_REQUEST')).toEqual([])
  })

  it('a request with no inner nonce is ignored', async () => {
    const { posted } = await bootMainWorld()
    authEvent({ nonce: 'env-1', request: {} })
    expect(posted.filter(([m]) => m.type === 'ATTESTTO_CW_AUTH_REQUEST')).toEqual([])
  })

  it('an error reply resolves the site with approved:false rather than hanging', async () => {
    const { reply } = await bootMainWorld()
    const responses: unknown[] = []
    window.addEventListener('credential-wallet:auth-response', (e) =>
      responses.push((e as CustomEvent).detail),
    )

    authEvent({ nonce: 'env-1', request: { nonce: 'sign-me' } })
    reply({ type: 'ATTESTTO_CW_AUTH_RESPONSE', requestId: 'env-1', error: 'user declined' })

    expect(responses).toEqual([{ nonce: 'env-1', response: { approved: false } }])
  })

  it('a successful reply is not overwritten by the later timeout', async () => {
    // Regression on the fix above. The listener is detached when the reply
    // lands, but the 120s timer is never cancelled — so without a latch it
    // dispatches `approved: false` two minutes after a SUCCESSFUL auth and the
    // site sees the failure last.
    vi.useFakeTimers()
    const { reply } = await bootMainWorld()
    const responses: unknown[] = []
    window.addEventListener('credential-wallet:auth-response', (e) =>
      responses.push((e as CustomEvent).detail),
    )

    authEvent({ nonce: 'env-1', request: { nonce: 'sign-me' } })
    reply({
      type: 'ATTESTTO_CW_AUTH_RESPONSE',
      requestId: 'env-1',
      response: { approved: true, proof: 'sig' },
    })
    vi.advanceTimersByTime(120_000)

    expect(responses).toEqual([{ nonce: 'env-1', response: { approved: true, proof: 'sig' } }])
  })

  it('the timeout also answers, instead of leaving the site waiting', async () => {
    // The error path above says in its own comment that it exists "rather than
    // letting it hang until its timeout". The timeout path used to remove the
    // listener and dispatch nothing, which is the exact outcome that comment
    // rejects — the site then waits out its own window with no reply.
    vi.useFakeTimers()
    const { reply } = await bootMainWorld()
    void reply
    const responses: unknown[] = []
    window.addEventListener('credential-wallet:auth-response', (e) =>
      responses.push((e as CustomEvent).detail),
    )

    authEvent({ nonce: 'env-1', request: { nonce: 'sign-me' } })
    expect(responses).toEqual([])

    vi.advanceTimersByTime(120_000)
    expect(responses).toEqual([{ nonce: 'env-1', response: { approved: false } }])
  })
})
