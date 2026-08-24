/**
 * SOC-145 — the default protocol reaches consent, through the real dispatch.
 *
 * `navigator.credentials.get({ attesttoVP: … })` sends `protocol: 'attestto'`.
 * That is what a relying party gets unless it explicitly asks for CHAPI, and it
 * had no completion route: the background raised an OS notification and
 * broadcast `CREDENTIAL_API_REQUEST_FORWARD`, which nothing listened to, while
 * the notification's buttons reached a listener that had been removed. The
 * page's promise sat until its own 300-second timeout and rejected with
 * `NotAllowedError: User did not respond in time` — indistinguishable from a
 * user who walked away.
 *
 * ## Why this drives the real listener
 *
 * The defect was never inside a handler; every handler had passing tests. It
 * was a branch that took a different exit. Only a test that enters the actual
 * `switch (message.type)` can see which exit a message takes, which is why this
 * boots the service worker rather than calling a function.
 *
 * The assertions are on the side effects the two exits differ by: the approval
 * window opening, and the notification NOT being raised. Asserting on the
 * handler's return value would have passed throughout the defect's lifetime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Listener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
) => unknown

/** See `background.dispatch.spec.ts` — the worker touches a wide, growing API surface. */
function autoStub(explicit: Record<string, unknown> = {}): unknown {
  const fn = (): Promise<undefined> => Promise.resolve(undefined)
  return new Proxy(fn, {
    get(_t, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (prop in explicit) return explicit[prop]
      return autoStub()
    },
    apply: () => Promise.resolve(undefined),
  })
}

interface Booted {
  listener: Listener
  windowsCreated: Array<Record<string, unknown>>
  notificationsCreated: string[]
  broadcasts: string[]
  stored: Record<string, unknown>
}

async function bootBackground(): Promise<Booted> {
  const listeners: Listener[] = []
  const windowsCreated: Array<Record<string, unknown>> = []
  const notificationsCreated: string[] = []
  const broadcasts: string[] = []
  const stored: Record<string, unknown> = {}

  const chromeStub = autoStub({
    runtime: autoStub({
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      id: 'test-extension-id',
      lastError: undefined,
      sendMessage: async (m: { type?: string }) => {
        if (m?.type) broadcasts.push(m.type)
        return undefined
      },
    }),
    storage: autoStub({
      local: autoStub({
        get: async () => ({ ...stored }),
        set: async (entries: Record<string, unknown>) => {
          Object.assign(stored, entries)
        },
      }),
      session: autoStub({ get: async () => ({}) }),
      onChanged: { addListener: vi.fn() },
    }),
    notifications: autoStub({
      create: (id: string) => {
        notificationsCreated.push(id)
        return Promise.resolve(id)
      },
    }),
    tabs: autoStub({ query: async () => [] }),
    windows: autoStub({
      create: async (opts: Record<string, unknown>) => {
        windowsCreated.push(opts)
        return { id: 99, tabs: [{ id: 99 }] }
      },
    }),
    permissions: autoStub({ contains: async () => true }),
  })

  vi.stubGlobal('chrome', chromeStub)
  vi.stubGlobal('defineBackground', (fn: () => void) => fn)

  const mod = (await import('@/entrypoints/background')) as unknown as { default: () => void }
  mod.default()

  expect(listeners.length).toBeGreaterThan(0)
  return { listener: listeners[0], windowsCreated, notificationsCreated, broadcasts, stored }
}

/** A page sender: unlike an extension page, it carries a tab, so it can be answered. */
const PAGE_SENDER = { tab: { id: 7 }, origin: 'https://rp.example', url: 'https://rp.example/login' }

function vpRequest(protocol: 'attestto' | 'chapi') {
  return {
    type: 'CREDENTIAL_API_REQUEST',
    payload: {
      requestId: `req-${protocol}-1`,
      protocol,
      challenge: protocol === 'chapi' ? 'chal' : null,
      domain: protocol === 'chapi' ? 'rp.example' : null,
      queryType: null,
      credentialType: 'VerifiableCredential',
      nonce: 'nonce-1',
      requestedFields: ['givenName'],
      audience: 'https://rp.example',
      origin: 'https://rp.example',
    },
  }
}

async function dispatch(booted: Booted, message: Record<string, unknown>) {
  const replies: unknown[] = []
  booted.listener(message, PAGE_SENDER, (r) => replies.push(r))
  // The case awaits the approval-window open before answering.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  return replies
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('CREDENTIAL_API_REQUEST — the proprietary protocol reaches consent', () => {
  it('opens an approval window for the default protocol', async () => {
    const booted = await bootBackground()

    await dispatch(booted, vpRequest('attestto'))

    expect(
      booted.windowsCreated.length,
      'the default protocol still takes an exit that opens no consent UI, so the ' +
        "page's promise hangs until its own 300s timeout",
    ).toBeGreaterThan(0)
  })

  it('raises no OS notification and broadcasts to no one', async () => {
    const booted = await bootBackground()

    await dispatch(booted, vpRequest('attestto'))

    expect(
      booted.notificationsCreated.filter((id) => id.startsWith('cred-api-')),
      'the inert notification is back — its buttons reach no listener',
    ).toEqual([])
    expect(
      booted.broadcasts,
      'CREDENTIAL_API_REQUEST_FORWARD is broadcast again, and nothing subscribes to it',
    ).not.toContain('CREDENTIAL_API_REQUEST_FORWARD')
  })

  it('routes both protocols the same way', async () => {
    const proprietary = await bootBackground()
    await dispatch(proprietary, vpRequest('attestto'))

    vi.resetModules()
    vi.unstubAllGlobals()
    const chapi = await bootBackground()
    await dispatch(chapi, vpRequest('chapi'))

    // CHAPI already worked. Comparing the two is what makes this a regression
    // test for the ROUTE rather than a restatement of the proprietary branch:
    // if the branch returns, these diverge.
    expect(proprietary.windowsCreated.length).toBe(chapi.windowsCreated.length)
  })
})
