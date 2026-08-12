/**
 * Global test setup — runs before every test file.
 *
 * Defines WXT auto-imported globals that are available at runtime in the
 * extension context but are not present in the Vitest / happy-dom environment.
 */

// defineContentScript is a WXT auto-import injected at build time.
// In tests we return the definition VERBATIM so modules that call it at parse
// time don't throw AND a spec can reach the real `main()` to exercise a content
// script end to end (see `background/transport/tab-responses.spec.ts`, which runs
// the real page bridge as the referent for the response contract). Returning `{}`
// here would have made that impossible.
if (typeof (globalThis as Record<string, unknown>).defineContentScript === 'undefined') {
  // @ts-expect-error — WXT global not typed in test env
  globalThis.defineContentScript = (opts: unknown) => opts
}
