/**
 * SOC-281 — the four sender guards, asserted at the message listener.
 *
 * SOC-2, SOC-3, SOC-8 and SOC-9 were closed in July by adding origin checks to
 * `background.ts`. Those checks are correct. Nothing held them there: inverting
 * either surviving guard left all 1293 tests, `type-check` and `lint:check`
 * green, so any refactor that dropped one shipped clean.
 *
 * This file is the missing half. `gate-self-test.mjs` seeds each inversion and
 * requires the run below to go red — see its SECURITY_MUTATIONS table, which
 * names this file. A test nobody can prove failing is the thing this repo keeps
 * rediscovering, so the two must ship together.
 *
 * Both guards read the origin from `sender`, which Chrome populates and a page
 * cannot forge. The payload-supplied `origin` is deliberately ignored, and the
 * refusal cases below pass a *hostile* `payload.origin` naming the platform to
 * prove the handler is not reading it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PLATFORM_URL, STORAGE_KEYS } from '@/config/app'

const HOSTILE = 'https://evil.example'

type Listener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
) => unknown

interface TabMessage {
  type: string
  payload: Record<string, unknown>
}

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

async function boot(): Promise<{ listener: Listener; toTab: TabMessage[] }> {
  const listeners: Listener[] = []
  const toTab: TabMessage[] = []

  vi.stubGlobal(
    'chrome',
    autoStub({
      runtime: autoStub({
        onMessage: { addListener: (l: Listener) => listeners.push(l) },
        getURL: (p: string) => `chrome-extension://test/${p}`,
        getContexts: async () => [],
        id: 'test-extension-id',
        lastError: undefined,
      }),
      storage: autoStub({
        // No trusted origins recorded — the hostile origin has never been approved.
        local: autoStub({ get: async () => ({ [STORAGE_KEYS.TRUSTED_ORIGINS]: {} }) }),
        session: autoStub({ get: async () => ({}) }),
        onChanged: { addListener: vi.fn() },
      }),
      tabs: autoStub({
        query: async () => [],
        sendMessage: (_id: number, msg: TabMessage) => {
          toTab.push(msg)
          return Promise.resolve(undefined)
        },
      }),
      windows: autoStub({ create: async () => ({ id: 1, tabs: [{ id: 1 }] }) }),
      permissions: autoStub({ contains: async () => true }),
    }),
  )
  vi.stubGlobal('defineBackground', (fn: () => void) => fn)

  const mod = (await import('@/entrypoints/background')) as unknown as { default: () => void }
  mod.default()
  expect(listeners.length).toBeGreaterThan(0)
  return { listener: listeners[0], toTab }
}

/** A content-script sender. Chrome always sets `tab` for one; extension pages never have it. */
const webSender = (origin: string): Record<string, unknown> => ({
  tab: { id: 5 },
  origin,
  url: `${origin}/page`,
})

/** An extension page — popup / options / approval. No `tab`. */
const extensionSender = (): Record<string, unknown> => ({
  url: 'chrome-extension://test/options.html',
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('SOC-281 — the sender guards hold, and can be proven to fail', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  describe('KEY_ROTATE is extension-only (SOC-8)', () => {
    it('refuses a web page even when it claims a platform origin in the payload', async () => {
      const { listener } = await boot()
      const sendResponse = vi.fn()

      listener(
        // The payload lies about where this came from. The guard must not care.
        { type: 'KEY_ROTATE', payload: { requestId: 'k1', origin: PLATFORM_URL } },
        webSender(HOSTILE),
        sendResponse,
      )
      await settle()

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden_sender' })
    })

    it('admits the extension’s own pages — the positive control', async () => {
      const { listener } = await boot()
      const sendResponse = vi.fn()

      listener({ type: 'KEY_ROTATE', payload: { requestId: 'k1' } }, extensionSender(), sendResponse)
      await settle()

      // Rotation itself needs an unlocked vault and will fail on this fixture.
      // What matters is that it was NOT turned away at the sender gate — a
      // refusal and an attempted-and-failed rotation are different outcomes.
      expect(sendResponse).not.toHaveBeenCalledWith({ ok: false, error: 'forbidden_sender' })
    })
  })

  describe('DID_SYNC requires an authorized origin (SOC-9)', () => {
    const payload = {
      requestId: 'd1',
      holderDid: 'did:jwk:attacker',
      verificationMethod: 'did:jwk:attacker#0',
      origin: PLATFORM_URL, // again, a lie the guard must ignore
    }

    it('refuses an untrusted origin and tells the tab why', async () => {
      const { listener, toTab } = await boot()
      const sendResponse = vi.fn()

      listener({ type: 'DID_SYNC', payload }, webSender(HOSTILE), sendResponse)
      await settle()

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'origin_not_authorized' })

      const reply = toTab.find((m) => m.type === 'DID_SYNC_RESPONSE')
      expect(reply?.payload.error).toBe('origin_not_authorized')
      // The attacker's DID must not come back as though it had been accepted.
      expect(reply?.payload.holderDid).toBeFalsy()
    })

    it('admits the platform origin — the positive control', async () => {
      const { listener } = await boot()
      const sendResponse = vi.fn()

      listener({ type: 'DID_SYNC', payload }, webSender(PLATFORM_URL), sendResponse)
      await settle()

      expect(sendResponse).not.toHaveBeenCalledWith({
        ok: false,
        error: 'origin_not_authorized',
      })
    })
  })
})
