import { describe, it, expect, vi } from 'vitest'

/**
 * Story 1.4 — the ONE honest runtime test (logic party Fork A). The capability
 * confinement (AD-1/2/3/4) is entirely compile-time: it is proven by the
 * `@ts-expect-error` tripwires in `ctx-bundles.type-guards.test-d.ts` under
 * `vue-tsc -b`. There is no non-circular runtime assertion about a type.
 *
 * The one runtime invariant `ports.ts` carries is a DIFFERENT one: it must be PURE
 * (no `chrome.*` / browser-global access at import time), because the bundles it
 * feeds are constructed in the MV3 service worker. This guard proves that
 * BEHAVIOURALLY (import with `chrome` absent, see it not throw) — NOT the
 * confinement, and its name says so.
 */
describe('PORTS MODULE PURITY — not the confinement proof (Fork A)', () => {
  it('loads with no browser globals present (pure type module)', async () => {
    const savedChrome = (globalThis as Record<string, unknown>).chrome
    delete (globalThis as Record<string, unknown>).chrome
    try {
      vi.resetModules()
      // A pure type-only module has no runtime exports; importing it must simply
      // not throw and must not require `chrome`. (Interfaces erase at compile time,
      // so the imported namespace is expected to be empty — the assertion is that
      // the import itself succeeds.)
      const mod = await import('./ports')
      expect(mod).toBeTypeOf('object')
    } finally {
      if (savedChrome !== undefined) {
        ;(globalThis as Record<string, unknown>).chrome = savedChrome
      }
    }
  })
})
