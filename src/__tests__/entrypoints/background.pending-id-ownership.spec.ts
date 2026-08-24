/**
 * SOC-278 — a live pending row cannot be replaced by the requester.
 *
 * The approval window renders from the URL it was opened with; the effect runs
 * against the stored row. The id joining those two halves is the `requestId`
 * the PAGE chose, and `put` overwrote unconditionally. So a page could open an
 * approval for document A, re-send with the same id and document B, and the
 * user would approve B while reading A. The signature is evidence of what the
 * user agreed to, and it was not bound to what they saw.
 *
 * ── What is asserted, and at which level ──────────────────────────────────
 *
 * The mechanism lives in `pending-store.put`, so that is where the atomicity
 * and the tombstone rule are pinned. But a store-level test alone would not
 * have caught the original defect: the store did exactly what its contract
 * said, and the contract was the bug. The listener case is therefore the one
 * that matters — it asserts a second request for a live id is REFUSED rather
 * than silently swallowed, which is the behaviour a page can actually observe.
 *
 * The storage stub is stateful on purpose. A stub that forgets between calls
 * makes every "second write" look like a first, and the test would pass against
 * the defect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPendingStore } from '@/background/consent/pending-store'
import { createPendingFlow } from '@/background/consent/pending-flow'

/** An in-memory chrome.storage.local — the state is the point. */
function statefulStorage(): {
  get: (key?: string) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  data: Record<string, unknown>
} {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: async (key?: string) => (key ? { [key]: data[key] } : { ...data }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
    },
  }
}

describe('SOC-278 — pending rows belong to the background, not the requester', () => {
  describe('the store refuses to replace a live row', () => {
    let flow: ReturnType<typeof createPendingFlow<{ doc: string }>>

    beforeEach(() => {
      const storage = statefulStorage()
      flow = createPendingFlow<{ doc: string }>(
        createPendingStore({ flow: 'test', storage, now: () => 1_000_000 }),
      )
    })

    it('the first write wins and the second is rejected', async () => {
      expect(await flow.put('req-1', { doc: 'A' })).toBe(true)
      expect(await flow.put('req-1', { doc: 'B' })).toBe(false)
    })

    it('the row still holds what was displayed, not what arrived second', async () => {
      await flow.put('req-1', { doc: 'A' })
      await flow.put('req-1', { doc: 'B' })

      // This is the assertion the whole ticket is about: approve after the swap
      // attempt, and the effect must see A.
      const outcome = await flow.approve('req-1', (row) => row.doc)
      expect(outcome).toEqual({ ok: true, value: 'A' })
    })

    it('concurrent writes for one id produce exactly one winner', async () => {
      // The check and the write share a queued operation, so two racers cannot
      // both observe the id as free.
      const results = await Promise.all([
        flow.put('req-1', { doc: 'A' }),
        flow.put('req-1', { doc: 'B' }),
        flow.put('req-1', { doc: 'C' }),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('a CONSUMED id does not block a genuinely new request', async () => {
      await flow.put('req-1', { doc: 'A' })
      await flow.approve('req-1', (row) => row.doc)

      // The tombstone means "this consent was acted on", not "this id is burned
      // forever". Blocking here would strand a caller that legitimately reuses
      // a counter-style id after completing a request.
      expect(await flow.put('req-1', { doc: 'B' })).toBe(true)
    })

    it('an untouched id is unaffected — the positive control', async () => {
      expect(await flow.put('req-1', { doc: 'A' })).toBe(true)
      expect(await flow.put('req-2', { doc: 'B' })).toBe(true)
      expect(await flow.peek('req-2')).toEqual({ doc: 'B' })
    })
  })

  describe('the listener refuses the duplicate rather than swallowing it', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.unstubAllGlobals()
    })

    it('a second SIGN_DOCUMENT_REQUEST for a live id is answered with an error', async () => {
      const store = statefulStorage()
      const listeners: Array<
        (m: Record<string, unknown>, s: Record<string, unknown>, r: (x?: unknown) => void) => unknown
      > = []

      const autoStub = (explicit: Record<string, unknown> = {}): unknown =>
        new Proxy((): Promise<undefined> => Promise.resolve(undefined), {
          get(_t, prop: string | symbol) {
            if (typeof prop === 'symbol') return undefined
            if (prop in explicit) return explicit[prop]
            return autoStub()
          },
          apply: () => Promise.resolve(undefined),
        })

      vi.stubGlobal(
        'chrome',
        autoStub({
          runtime: autoStub({
            onMessage: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) },
            getURL: (p: string) => `chrome-extension://test/${p}`,
            getContexts: async () => [],
            id: 'test-extension-id',
            lastError: undefined,
          }),
          storage: autoStub({
            local: autoStub({ get: async () => ({}) }),
            // The pending store lives in SESSION storage — stubbing `local` here
            // would leave every duplicate looking like a first write.
            session: autoStub({ get: store.get, set: store.set }),
            onChanged: { addListener: vi.fn() },
          }),
          tabs: autoStub({ query: async () => [], sendMessage: async () => undefined }),
          windows: autoStub({ create: async () => ({ id: 1, tabs: [{ id: 1 }] }) }),
          permissions: autoStub({ contains: async () => true }),
        }),
      )
      vi.stubGlobal('defineBackground', (fn: () => void) => fn)

      const mod = (await import('@/entrypoints/background')) as unknown as { default: () => void }
      mod.default()
      const listener = listeners[0]

      const sender = { tab: { id: 3 }, origin: 'https://site.example', url: 'https://site.example/p' }
      const send = (documentTitle: string, reply: (r?: unknown) => void): void => {
        listener(
          {
            type: 'SIGN_DOCUMENT_REQUEST',
            payload: { requestId: 'dup-1', documentTitle, signingToken: 't', origin: 'https://site.example' },
          },
          sender,
          reply,
        )
      }

      const first = vi.fn()
      send('Contract A', first)
      await new Promise((r) => setTimeout(r, 0))

      const second = vi.fn()
      send('Contract B — swapped', second)
      await new Promise((r) => setTimeout(r, 0))

      expect(first).toHaveBeenCalledWith({ ok: true })
      // Refused, and observably so. A silent drop would leave the page hanging
      // until its own timeout, which reads to an integrator as "user ignored it".
      expect(second).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: expect.stringContaining('already awaiting') }),
      )
    })
  })
})
