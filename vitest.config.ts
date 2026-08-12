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
      /**
       * `*.test-d.ts` are type-level tests. They are test code, not shipped
       * source, but only `*.spec.ts` was excluded — so six of them were counted
       * as uncovered application files and dragged every number down. A floor
       * derived from a denominator that includes the tests themselves measures
       * something nobody meant to measure, and "coverage went up" could then be
       * achieved by deleting a type test.
       */
      exclude: ['src/**/*.spec.ts', 'src/**/*.test-d.ts'],
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
        /**
         * Global: a BACKSTOP, deliberately kept slack — unlike the per-area
         * floors below, which are set just under what their area measures.
         *
         * The two serve different purposes and should not share a convention.
         * A per-area floor detects a real regression: `services` sliding from
         * 95% to 50% is a fact about one area, and its floor names that area
         * when it trips. The global number moves whenever ANY file is added,
         * so ratcheting it tight mostly detects that someone wrote a file —
         * and it reports that as "branches 50.9 < 51", which says nothing
         * about the change that caused it.
         *
         * It was briefly ratcheted to 60/51/55/61 against a measured
         * 61.52/51.76/56.02/62.50, leaving 0.76 points of headroom on
         * branches: about one new component with a few untested conditionals.
         * Backed off to roughly four points of slack, matching the margin the
         * per-area floors carry. Raise it when a whole tranche of the codebase
         * comes under test, not on every PR that adds coverage.
         *
         * History: 45→50→52→54→56 as the entrypoints came under test
         * (background.ts 0→66%, credential-api.content.ts 26→87%,
         * credential-handler.content.ts 0→73%, trust-bar.content.ts 13→83%,
         * approval/App.vue 0→53%, webauthn.ts 64→94%). The `*.test-d.ts`
         * exclude above also lifted every number, by removing type tests that
         * had been counted as uncovered source rather than as test code.
         */
        statements: 57,
        branches: 48,
        functions: 53,
        lines: 58,
        // Vault backup, Shamir recovery, credential handling. Measured 94.6%.
        'src/services/**': { statements: 90, branches: 85, functions: 88, lines: 90 },
        // DID resolution and document handling. Measured 96.1%.
        'src/background/did/**': { statements: 92, branches: 88, functions: 90, lines: 92 },
        // Crypto helpers, vault, trusted origins, passphrase KDF. Measured 71.4%,
        // up from 63.9% now that `unlockWithPasskey` is covered (SOC-236):
        // webauthn.ts alone went 64.2 -> 93.7% statements, 45.5 -> 84.1% branches.
        'src/utils/**': { statements: 69, branches: 65, functions: 68, lines: 73 },
        // The composition root — the 42-case dispatch. Measured 66.1%, up from
        // ZERO: nothing had ever imported the module. Floored so the reachability
        // spec cannot be quietly deleted without a red build.
        'src/entrypoints/background.ts': { statements: 60, branches: 50, functions: 44, lines: 60 },
        // The consent window — the only thing between a site asking for a
        // signature and the signature happening. Measured 52.7%, up from ZERO:
        // it had no spec and, unlike every other area here, no floor either, so
        // it could have rotted to nothing without reddening a build. The tested
        // half is the half that matters (the ATT-1098 verification gate, the
        // PRF skip, the pairwise-auth payload, deny routing); the untested
        // remainder is template and recovery-flow branches.
        'src/entrypoints/approval/**': { statements: 50, branches: 22, functions: 24, lines: 52 },
        // The untrusted boundary — runs on every https page. Measured 87.4%.
        // Floored so the origin invariant cannot lose its only assertion.
        'src/entrypoints/credential-api.content.ts': { statements: 80, branches: 78, functions: 90, lines: 80 },
        // MAIN world — it monkey-patches navigator.credentials.get on every
        // https page, so a regression here breaks passkey login site-wide.
        'src/entrypoints/credential-handler.content.ts': { statements: 70, branches: 64, functions: 74, lines: 74 },
        // The threat report is the only thing in this feature that leaves the
        // user's machine, and its allowed-field list lived only in a comment.
        'src/entrypoints/trust-bar.content.ts': { statements: 80, branches: 55, functions: 78, lines: 82 },
      },
    },
  },
})
