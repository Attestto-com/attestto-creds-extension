/**
 * Global test setup — runs before every test file.
 *
 * Defines WXT auto-imported globals that are available at runtime in the
 * extension context but are not present in the Vitest / happy-dom environment.
 */

// defineContentScript is a WXT auto-import injected at build time.
// In tests we provide a no-op stub so modules that call it at parse time don't throw.
if (typeof (globalThis as Record<string, unknown>).defineContentScript === 'undefined') {
  // @ts-expect-error — WXT global not typed in test env
  globalThis.defineContentScript = (_opts: unknown) => ({})
}
