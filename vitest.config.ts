import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../frontend/src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    /**
     * Story 1.18 — no unit test may make a real network call.
     *
     * happy-dom loads CSS and JS referenced by parsed HTML by DEFAULT. A
     * `site-health` fixture containing `<link rel="stylesheet" href="/wp-content/…">`
     * therefore fired a real `fetch()`, resolved against happy-dom's default
     * origin (`http://localhost:3000` — DOMParser sets no document URL), and
     * failed with a NetworkError. The fetch is fire-and-forget, so its async
     * rejection raced the test lifecycle: green on one run, red on the next.
     *
     * A unit test reaching the network is the "green means nothing" smell at the
     * suite layer — it makes the result depend on what is listening on port 3000.
     * Disabled globally rather than per-spec so no future fixture can reintroduce it.
     */
    environmentOptions: {
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
          disableJavaScriptEvaluation: true,
        },
      },
    },
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,vue}'],
      exclude: ['src/**/*.spec.ts'],
      /**
       * Coverage was computed and never enforced — `test:coverage` existed, no
       * CI step ran it, no threshold read it. So "is this tested?" could only
       * be answered by grepping which module a spec imports.
       *
       * The global number is 48%, and quoting that alone would misdescribe the
       * repo in both directions. It is dragged down by Vue views (0%, no unit
       * tests planned) and by `src/entrypoints/background.ts` (5.9%), while the
       * logic Story 1.13 extracted OUT of that service worker sits at 94–98%.
       *
       * So the floors are per-area rather than one global figure. A single
       * threshold low enough for the views to pass would let `services` rot
       * from 95% to 50% without a red build — a gate that cannot notice the
       * regression it exists to catch.
       *
       * Every number is set just below what the suite measures TODAY. Raising
       * them as coverage rises is the intended edit; lowering one to make a
       * build pass is how this becomes decorative.
       */
      thresholds: {
        // Global: stops overall regression without demanding UI tests.
        // Ratcheted 45→50→52 as background.ts (0→66%) and
        // credential-api.content.ts (26→87%) came under test.
        statements: 52,
        branches: 44,
        functions: 50,
        lines: 52,
        // Vault backup, Shamir recovery, credential handling. Measured 94.6%.
        'src/services/**': { statements: 90, branches: 85, functions: 88, lines: 90 },
        // DID resolution and document handling. Measured 96.1%.
        'src/background/did/**': { statements: 92, branches: 88, functions: 90, lines: 92 },
        // Crypto helpers, vault, trusted origins, passphrase KDF. Measured 63.9%.
        'src/utils/**': { statements: 60, branches: 58, functions: 60, lines: 62 },
        // The composition root — the 42-case dispatch. Measured 66.1%, up from
        // ZERO: nothing had ever imported the module. Floored so the reachability
        // spec cannot be quietly deleted without a red build.
        'src/entrypoints/background.ts': { statements: 60, branches: 50, functions: 44, lines: 60 },
        // The untrusted boundary — runs on every https page. Measured 87.4%.
        // Floored so the origin invariant cannot lose its only assertion.
        'src/entrypoints/credential-api.content.ts': { statements: 80, branches: 78, functions: 90, lines: 80 },
      },
    },
  },
})
