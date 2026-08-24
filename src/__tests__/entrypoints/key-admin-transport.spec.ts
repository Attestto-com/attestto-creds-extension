/**
 * SOC-144 — rotate / backup / restore can now answer the caller that is allowed
 * to call them.
 *
 * These three are Options-UI-only by design: they mutate or export the vault
 * signing key, so the content script bridges none of them and the case rejects
 * any sender carrying a tab (SOC-2 / SOC-3 / SOC-8). That design was correct.
 * The transport contradicted it.
 *
 * Each case handed its result to `sendKey*Response(tabId, …)`, which posts with
 * `chrome.tabs.sendMessage`. An extension page has no `sender.tab`, so `tabId`
 * was `null` on every real call and `deliverable()` dropped the reply with a
 * console warning. **The only permitted sender was the only unanswerable one.**
 * The result now travels on `sendResponse`, the channel the caller awaits.
 *
 * ## Why this drives the real listener
 *
 * The handlers had 13 passing unit tests throughout. They were never the
 * problem: a tested core behind a door with no handle. Only entering the actual
 * `switch (message.type)`, with a sender shaped like the real caller, can show
 * whether an answer comes back — which is the whole claim of this ticket.
 *
 * So the sender here deliberately has **no `tab`**. Give it one and the case
 * rejects it as a web page, which is the other half of the design.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Listener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
) => unknown

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
  tabMessages: unknown[]
}

async function bootBackground(): Promise<Booted> {
  const listeners: Listener[] = []
  const tabMessages: unknown[] = []

  const chromeStub = autoStub({
    runtime: autoStub({
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      id: 'test-extension-id',
      lastError: undefined,
    }),
    storage: autoStub({
      local: autoStub({ get: async () => ({}) }),
      session: autoStub({ get: async () => ({}) }),
      onChanged: { addListener: vi.fn() },
    }),
    // Anything posted to a tab is recorded, so the test can assert the result
    // does NOT go out that way any more.
    tabs: autoStub({
      query: async () => [],
      sendMessage: async (_id: number, m: unknown) => {
        tabMessages.push(m)
        return undefined
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
  return { listener: listeners[0], tabMessages }
}

/**
 * An extension page: options, popup or approval. The absence of `tab` is the
 * whole point — it is what made these three unanswerable.
 */
const EXTENSION_ORIGIN = 'chrome-extension://test'

const EXTENSION_SENDER = {
  id: 'test-extension-id',
  origin: EXTENSION_ORIGIN,
  // MUST match what the boot stub's `chrome.runtime.getURL('')` returns:
  // `isExtensionSender` requires `sender.url` to start with the extension's own
  // origin. An unmatched URL is rejected as a foreign sender, and every
  // assertion below would then pass against `forbidden_sender` — a green suite
  // measuring the guard instead of the transport.
  url: `${EXTENSION_ORIGIN}/options.html`,
}

/** A web page. Carries a tab, and must be rejected by every one of the three. */
const PAGE_SENDER = { tab: { id: 4 }, origin: 'https://rp.example', url: 'https://rp.example/' }

async function ask(
  booted: Booted,
  message: Record<string, unknown>,
  sender: Record<string, unknown> = EXTENSION_SENDER,
): Promise<{ reply: unknown; keptChannelOpen: boolean }> {
  let reply: unknown
  let answered = false
  const returned = booted.listener(message, sender, (r) => {
    reply = r
    answered = true
  })
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  return { reply: answered ? reply : undefined, keptChannelOpen: returned === true }
}

const ROTATE = { type: 'KEY_ROTATE', payload: { requestId: 'r-1', origin: 'chrome-extension://test' } }

/**
 * `KEY_BACKUP` and `KEY_RESTORE` were rows here and are deliberately gone.
 *
 * This spec arrived with the fix that made key admin answer over `sendResponse`
 * instead of `chrome.tabs`, and it covered all three operations. On this branch
 * only rotate still exists: backup and restore were deleted, not re-transported,
 * because they split the RAW private key 2-of-3 — a guardian held a piece of the
 * signing key — and a completed recovery returned a signer with no credentials,
 * since those hang off `LinkedIdentity`. `services/vault-backup.ts` already had
 * the version that works, encrypting the whole vault and splitting its content
 * key.
 *
 * Re-adding rows for them would not be restoring coverage; it would be asserting
 * that a deleted capability still answers. If either type ever comes back, it
 * needs this file AND a reason the raw-key split is no longer what it was.
 */

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('key admin transport — the permitted caller gets an answer', () => {
  it.each([
    ['KEY_ROTATE', ROTATE],
  ])("%s answers the caller with the handler's own outcome", async (_name, message) => {
    const booted = await bootBackground()

    const { reply } = await ask(booted, message)

    // `toBeDefined()` is NOT enough here, and that is the point of asserting on
    // the CONTENT. The guard's refusal is also a defined object, so a sender
    // shape the guard rejects would satisfy a mere existence check while
    // exercising none of the transport. This first assertion is what tells the
    // two apart.
    expect(
      reply,
      'the message never reached the handler — it was refused by the sender guard, ' +
        'so this test proves nothing about the transport',
    ).not.toEqual({ ok: false, error: 'forbidden_sender' })

    // The vault is locked in this fixture, so every handler reports that. What
    // matters is that ITS answer is what came back: a bare `{ ok: true }` ack,
    // which is what the old code sent while dropping the real result on the
    // floor, does not carry it.
    expect(reply).toEqual({ ok: false, error: 'Vault is locked' })
  })

  it.each([
    ['KEY_ROTATE', ROTATE],
  ])('%s sends nothing to a tab', async (_name, message) => {
    const booted = await bootBackground()

    await ask(booted, message)

    expect(
      booted.tabMessages,
      'the result went out over chrome.tabs again — there is no tab to receive it, ' +
        'because the caller is an extension page',
    ).toEqual([])
  })

  it.each([
    ['KEY_ROTATE', ROTATE],
  ])('%s still refuses a web page', async (_name, message) => {
    const booted = await bootBackground()

    // The control case for the other half of the design. Without it, a case
    // that answered EVERYONE would satisfy every assertion above while handing
    // key rotation to any origin that asked.
    const { reply } = await ask(booted, message, PAGE_SENDER)

    expect(reply).toEqual({ ok: false, error: 'forbidden_sender' })
  })
})
