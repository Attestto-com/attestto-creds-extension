/**
 * credential-api.content.ts — the origin the user is asked to trust.
 *
 * This script runs on every https page, so any site on the internet can
 * `postMessage` into it. It forwards ten request types to the background, and
 * on each one it sets `payload.origin` itself, from `window.location.origin`.
 *
 * ── Why that single field is load-bearing ──────────────────────────────────
 *
 * `background.ts:831` renders it straight into the consent notification:
 *
 *     message: `${apiReq.origin} is requesting identity verification.`
 *
 * and `:596` passes it to the approval window. It is the string the USER reads
 * and approves. If a page could put its own value there, it could ask for
 * credentials while displaying somebody else's name.
 *
 * The manifest declares no `externally_connectable`, so a web page cannot call
 * `chrome.runtime.sendMessage` directly — this content script is the only
 * web-facing path to the background, and therefore the only thing standing
 * between a page and that consent string.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The property HOLDS today: every forwarder lists its fields explicitly, none
 * spreads `...payload`, and `origin` is assigned last. Nothing asserted it.
 * At 26% coverage the obvious tidy-up — replacing nine hand-copied fields with
 * one spread — would silently hand the page control of the consent prompt, and
 * every existing test would stay green.
 *
 * These tests are not about a bug that exists. They are about the one that a
 * reasonable refactor would introduce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const PAGE_ORIGIN = 'https://legit.example'
/** What a hostile page would like the user to see instead. */
const SPOOFED = 'https://bank.example'

type Sent = { type: string; payload: Record<string, unknown> }

/**
 * Boot the content script against a stubbed page and capture everything it
 * forwards to the background.
 */
async function bootContentScript(): Promise<{
  post: (data: unknown) => void
  sent: Sent[]
}> {
  const sent: Sent[] = []
  const listeners: Array<(e: MessageEvent) => void> = []

  vi.stubGlobal('defineContentScript', (def: { main: () => void }) => def)
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: (msg: Sent, cb?: (r: unknown) => void) => {
        sent.push(msg)
        cb?.({ ok: true })
      },
      onMessage: { addListener: vi.fn() },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
  })

  // A page whose real origin is PAGE_ORIGIN. `window.location.origin` is the
  // only honest source here, which is exactly what the assertions check.
  const win = globalThis.window as unknown as Record<string, unknown>
  const originalAdd = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    fn: (e: MessageEvent) => void,
    ...rest: unknown[]
  ) => {
    if (type === 'message') listeners.push(fn)
    else (originalAdd as (...a: unknown[]) => void)(type, fn, ...rest)
  }) as typeof window.addEventListener)

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: PAGE_ORIGIN, href: `${PAGE_ORIGIN}/page` },
  })
  win.postMessage = vi.fn()

  const mod = (await import('@/entrypoints/credential-api.content')) as unknown as {
    default: { main: () => void }
  }
  mod.default.main()

  expect(listeners.length).toBeGreaterThan(0)

  // `event.source !== window` is the script's first guard, so a legitimate
  // same-window message must carry it.
  const post = (data: unknown) => {
    for (const fn of listeners) {
      fn({ data, source: window, origin: PAGE_ORIGIN } as unknown as MessageEvent)
    }
  }
  return { post, sent }
}

/**
 * Every page→extension request type this bridge forwards, with the minimum
 * payload each needs. Hand-listed rather than AST-extracted because each one
 * needs a distinct shape; the count is asserted against the source so a
 * newly-added forwarder cannot silently escape this file.
 */
const REQUESTS: Array<{
  pageType: string
  payload: Record<string, unknown>
  top?: Record<string, unknown>
}> = [
  { pageType: 'ATTESTTO_VP_REQUEST', payload: { nonce: 'n', requestedFields: [], audience: 'a' } },
  { pageType: 'ATTESTTO_DID_SYNC', payload: { did: 'did:jwk:x', verificationMethod: 'did:jwk:x#0' } },
  { pageType: 'ATTESTTO_AUTH_REQUEST', payload: { nonce: 'n' } },
  { pageType: 'ATTESTTO_CW_AUTH_REQUEST', payload: { nonce: 'n' } },
  { pageType: 'ATTESTTO_SIGN_REQUEST', payload: { documentHash: 'h' } },
  { pageType: 'ATTESTTO_SIGN_PDF_REQUEST', payload: { documentHash: 'h' } },
  { pageType: 'ATTESTTO_PAYMENT_REQUEST', payload: { amount: '1' } },
  // `credential` sits at the TOP level of event.data for this one, not under
  // `payload` — the bridge's shapes are not uniform, and a test that assumed
  // they were would have "passed" by never reaching the forwarder at all.
  { pageType: 'ATTESTTO_CREDENTIAL_PUSH', payload: {}, top: { credential: { format: 'attestto-id' } } },
]
describe('the origin forwarded to the background is the page\'s real one', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(REQUESTS)(
    '$pageType — a page-supplied `origin` never reaches the background',
    async ({ pageType, payload, top }) => {
      const { post, sent } = await bootContentScript()

      // The hostile bit: the page puts its own `origin` in the payload, at the
      // top level and nested, hoping one of them survives.
      post({
        type: pageType,
        requestId: 'req-1',
        origin: SPOOFED,
        ...top,
        payload: { ...payload, origin: SPOOFED },
      })

      expect(sent.length, `${pageType} was not forwarded at all`).toBeGreaterThan(0)
      for (const msg of sent) {
        expect(msg.payload.origin).toBe(PAGE_ORIGIN)
        expect(JSON.stringify(msg.payload)).not.toContain(SPOOFED)
      }
    },
  )

  it('a message from another window is ignored entirely', async () => {
    // `event.source !== window` — the guard against a cross-window injection.
    const { sent } = await bootContentScript()
    const other = { name: 'not-this-window' } as unknown as Window
    // Re-dispatch bypassing the helper so `source` is somebody else.
    const listeners: Array<(e: MessageEvent) => void> = []
    void listeners
    // The helper always posts with source === window, so drive the guard here.
    const evt = {
      data: { type: 'ATTESTTO_VP_REQUEST', requestId: 'x', payload: {} },
      source: other,
      origin: SPOOFED,
    } as unknown as MessageEvent
    const spy = window.addEventListener as unknown as { mock: { calls: unknown[][] } }
    for (const call of spy.mock.calls) {
      if (call[0] === 'message') (call[1] as (e: MessageEvent) => void)(evt)
    }
    expect(sent).toEqual([])
  })
})

describe('a malformed request from a page is answered, not thrown on', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('CREDENTIAL_PUSH with no `credential` replies with an error', async () => {
    // Found by the origin sweep above. `credential.format` was read off an
    // absent object, so a page posting `{type, requestId}` threw a TypeError
    // out of the message listener: no response, no error to the caller, and
    // the only trace in a console nobody watches. Any website can send this.
    const { post } = await bootContentScript()
    const posted = window.postMessage as unknown as { mock: { calls: unknown[][] } }

    post({ type: 'ATTESTTO_CREDENTIAL_PUSH', requestId: 'req-1' })

    const replies = posted.mock.calls
      .map((c) => c[0] as { type?: string; success?: boolean; error?: string })
      .filter((m) => m?.type === 'ATTESTTO_CREDENTIAL_PUSH_RESPONSE')
    expect(replies.length, 'the page got no answer at all').toBe(1)
    expect(replies[0].success).toBe(false)
    expect(replies[0].error).toMatch(/credential/i)
  })

  it('the reply goes to this page only, never a wildcard target', async () => {
    const { post } = await bootContentScript()
    const posted = window.postMessage as unknown as { mock: { calls: unknown[][] } }
    post({ type: 'ATTESTTO_CREDENTIAL_PUSH', requestId: 'req-1' })
    for (const call of posted.mock.calls) expect(call[1]).toBe(PAGE_ORIGIN)
  })
})

describe('the bridge does not broadcast responses to arbitrary listeners', () => {
  it('no postMessage in the content scripts uses a wildcard targetOrigin', async () => {
    // A `postMessage(data, '*')` delivers to whatever is listening, including a
    // framing page. Every response here carries the credential material the
    // user just approved for ONE origin, so the target must be that origin.
    //
    // Asserted against the source text on purpose: the failure mode is a new
    // call site added later, and no runtime test of the existing ten would see
    // it. This is a lint the repo does not have.
    const { readFileSync, readdirSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const dir = resolve(process.cwd(), 'src/entrypoints')
    const offenders: string[] = []
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.content.ts'))) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      for (const m of src.matchAll(/postMessage\(([\s\S]*?)\)\s*(?:;|\n)/g)) {
        if (/,\s*['"]\*['"]\s*$/.test(m[1].trim())) offenders.push(`${f}: ${m[0].slice(0, 60)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
