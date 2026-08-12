import { describe, it, expect, vi } from 'vitest'

/**
 * Story 1.2 — the ONE honest runtime test for `response.ts` (logic party Fork A).
 *
 * The envelope contract is compile-time: `Response<T>` narrowing, the brand's
 * single-writer guarantee, and `ErrorCode`'s closedness are all proven by the
 * `@ts-expect-error` tripwires in `response.type-guards.test-d.ts` under
 * `vue-tsc -b`. A runtime assertion like `expect(ok(x).data).toBe(x)` is CIRCULAR
 * — the constructor asserted against what the constructor emits, the govscan
 * source-mirror sin in equality clothing — and is deliberately absent.
 *
 * The only non-circular runtime invariant `response.ts` carries is a DIFFERENT one:
 * because the module is imported into the MV3 service worker, it must be PURE
 * (NFR-3 / MV3-CSP) — no browser-global access at import time. This guard proves
 * that BEHAVIOURALLY (import it with `chrome` absent and see it not throw), not by
 * matching source text — a `/chrome\./` regex would match this very file's own
 * doc comment, which is exactly why source-grep "tests" are banned here.
 */
describe('MODULE PURITY — not the envelope contract (Fork A)', () => {
  it('loads with no browser globals present (no `chrome.*`/DOM access at module top)', async () => {
    // happy-dom provides no `chrome`; if `response.ts` ever grew an import-time
    // side effect touching a browser API (e.g. `chrome.runtime.getURL(...)` at
    // module scope), this fresh import would throw a ReferenceError → red. That
    // added side effect is the mutation this test bites on.
    const savedChrome = (globalThis as Record<string, unknown>).chrome
    delete (globalThis as Record<string, unknown>).chrome
    try {
      vi.resetModules()
      const mod = await import('./response')
      expect(typeof mod.ok).toBe('function')
      expect(typeof mod.fail).toBe('function')
    } finally {
      if (savedChrome !== undefined) {
        ;(globalThis as Record<string, unknown>).chrome = savedChrome
      }
    }
  })
})
