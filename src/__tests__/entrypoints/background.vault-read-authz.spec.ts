/**
 * SOC-277 — vault READ authorization, asserted through the message listener.
 *
 * `LIST_STORED_CREDENTIALS` and `RESHARE_STORED_VP` project stored credentials
 * out to the caller: metadata plus claim key NAMES from the first, claim VALUES
 * from the second. Both were reachable from the `https://*` content-script
 * bridge with no check on the sender at all.
 *
 * ── Why this file is at the LISTENER, not the handler ─────────────────────
 *
 * `summarizeStoredCredentials` and `buildResharePresentation` are correct in
 * isolation and have their own specs. They project exactly what they are asked
 * to project. The defect was never in them — it was that nothing decided WHO
 * was allowed to ask. A handler-level test cannot fail on that no matter how
 * the routing changes, which is why the defect survived both the July audit and
 * the Epic-1 hardening pass with a green suite the whole way.
 *
 * So the referent here is the same one `background.dispatch.spec.ts` uses: boot
 * the real service worker, hand it a real sender shape, and assert on what
 * reaches the tab.
 *
 * ── The positive control is load-bearing ──────────────────────────────────
 *
 * A test that only asserts "the hostile origin got nothing" passes just as
 * happily against a wallet that answers nobody — including one broken so badly
 * it never reads the vault at all. Each refusal case below is therefore paired
 * with a trusted-origin case over the SAME fixture, asserting the claim value
 * does come back. The pair is what makes the refusal meaningful.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { STORAGE_KEYS } from '@/config/app'

const HOSTILE = 'https://evil.example'
const TRUSTED = 'https://partner.example'
const CEDULA = '1-2345-6789'

/** One credential with a claim whose value must never reach an unauthorized caller. */
const VAULT_FIXTURE = {
  credentials: [
    {
      id: 'cred-1',
      format: 'sd-jwt',
      issuer: 'did:web:issuer.example',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      types: ['IdentityCredential'],
      decodedClaims: { cedula: CEDULA, name: 'Test Holder' },
      raw: 'eyJ.fixture.token',
      metadata: { source: 'test' },
    },
  ],
}

vi.mock('@/utils/vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/vault')>()
  return { ...actual, readVault: vi.fn(async () => VAULT_FIXTURE) }
})

type Listener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
) => unknown

interface TabMessage {
  type: string
  payload: Record<string, unknown>
}

/** See background.dispatch.spec.ts — same self-completing chrome stub. */
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

/**
 * Boot the worker with `trustedOrigin` (if any) already approved, and collect
 * everything the background pushes to a tab.
 */
async function boot(trustedOrigin?: string): Promise<{
  listener: Listener
  toTab: TabMessage[]
}> {
  const listeners: Listener[] = []
  const toTab: TabMessage[] = []

  const trustedMap = trustedOrigin
    ? { [trustedOrigin]: { trustedSince: '2026-01-01T00:00:00.000Z', lastUsed: '2026-01-01T00:00:00.000Z' } }
    : {}

  const chromeStub = autoStub({
    runtime: autoStub({
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      id: 'test-extension-id',
      lastError: undefined,
    }),
    storage: autoStub({
      local: autoStub({
        get: async (key?: string) =>
          key === STORAGE_KEYS.TRUSTED_ORIGINS ? { [STORAGE_KEYS.TRUSTED_ORIGINS]: trustedMap } : {},
      }),
      session: autoStub({ get: async () => ({}) }),
      onChanged: { addListener: vi.fn() },
    }),
    tabs: autoStub({
      query: async () => [],
      sendMessage: (_tabId: number, msg: TabMessage) => {
        toTab.push(msg)
        return Promise.resolve(undefined)
      },
    }),
    windows: autoStub({ create: async () => ({ id: 1, tabs: [{ id: 1 }] }) }),
    permissions: autoStub({ contains: async () => true }),
  })

  vi.stubGlobal('chrome', chromeStub)
  vi.stubGlobal('defineBackground', (fn: () => void) => fn)

  const mod = (await import('@/entrypoints/background')) as unknown as { default: () => void }
  mod.default()

  expect(listeners.length).toBeGreaterThan(0)
  return { listener: listeners[0], toTab }
}

/** A web page. Chrome always sets `tab` for a content-script sender. */
function webSender(origin: string): Record<string, unknown> {
  return { tab: { id: 7 }, origin, url: `${origin}/page` }
}

/** Let the handler's promise chain settle before asserting on what it sent. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('SOC-277 — a web origin cannot read the vault unless it is authorized', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  describe('LIST_STORED_CREDENTIALS', () => {
    it('refuses an unauthorized origin and discloses no claim keys', async () => {
      const { listener, toTab } = await boot()
      const sendResponse = vi.fn()

      listener(
        { type: 'LIST_STORED_CREDENTIALS', payload: { requestId: 'r1' } },
        webSender(HOSTILE),
        sendResponse,
      )
      await settle()

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'origin_not_authorized' })

      const reply = toTab.find((m) => m.type === 'LIST_STORED_CREDENTIALS_RESPONSE')
      expect(reply?.payload.credentials).toEqual([])
      // Not just "no values" — the KEY NAMES are a targeting surface too.
      expect(JSON.stringify(toTab)).not.toContain('cedula')
    })

    it('serves a trusted origin — the positive control', async () => {
      const { listener, toTab } = await boot(TRUSTED)
      const sendResponse = vi.fn()

      listener(
        { type: 'LIST_STORED_CREDENTIALS', payload: { requestId: 'r1' } },
        webSender(TRUSTED),
        sendResponse,
      )
      await settle()

      expect(sendResponse).toHaveBeenCalledWith({ ok: true })

      const reply = toTab.find((m) => m.type === 'LIST_STORED_CREDENTIALS_RESPONSE')
      const credentials = reply?.payload.credentials as Array<{ claimKeys: string[] }>
      expect(credentials).toHaveLength(1)
      expect(credentials[0].claimKeys).toContain('cedula')
    })
  })

  describe('RESHARE_STORED_VP', () => {
    const request = {
      requestId: 'r2',
      credentialId: 'cred-1',
      selectedFields: ['cedula', 'name'],
    }

    it('refuses an unauthorized origin and discloses no claim VALUES', async () => {
      const { listener, toTab } = await boot()
      const sendResponse = vi.fn()

      listener({ type: 'RESHARE_STORED_VP', payload: request }, webSender(HOSTILE), sendResponse)
      await settle()

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'origin_not_authorized' })

      const reply = toTab.find((m) => m.type === 'RESHARE_STORED_VP_RESPONSE')
      expect(reply?.payload.error).toBe('origin_not_authorized')
      expect(reply?.payload.presentation).toBeUndefined()
      // Assert against the SERIALIZED payload, not a key list: a projection that
      // leaks by nesting passes a key check and fails a substring check.
      expect(JSON.stringify(toTab)).not.toContain(CEDULA)
    })

    it('serves a trusted origin — the positive control', async () => {
      const { listener, toTab } = await boot(TRUSTED)
      const sendResponse = vi.fn()

      listener({ type: 'RESHARE_STORED_VP', payload: request }, webSender(TRUSTED), sendResponse)
      await settle()

      expect(sendResponse).toHaveBeenCalledWith({ ok: true })
      expect(JSON.stringify(toTab)).toContain(CEDULA)
    })
  })

  /**
   * The chain is the exploit: step one hands the attacker the claim key names,
   * step two exchanges them for the values. Asserting it end to end pins the
   * whole primitive rather than two halves that could be re-opened separately.
   */
  it('the two-step enumerate-then-exfiltrate chain yields nothing to a hostile page', async () => {
    const { listener, toTab } = await boot()
    const sendResponse = vi.fn()

    listener(
      { type: 'LIST_STORED_CREDENTIALS', payload: { requestId: 'a' } },
      webSender(HOSTILE),
      sendResponse,
    )
    await settle()

    const listed = toTab.find((m) => m.type === 'LIST_STORED_CREDENTIALS_RESPONSE')
    const discovered = (listed?.payload.credentials as Array<{ claimKeys: string[] }>) ?? []
    expect(discovered).toEqual([])

    // Even guessing the credential id and the common claim names, step two must
    // refuse — the gate cannot depend on step one having withheld anything.
    listener(
      {
        type: 'RESHARE_STORED_VP',
        payload: { requestId: 'b', credentialId: 'cred-1', selectedFields: ['cedula'] },
      },
      webSender(HOSTILE),
      sendResponse,
    )
    await settle()

    expect(JSON.stringify(toTab)).not.toContain(CEDULA)
  })
})
