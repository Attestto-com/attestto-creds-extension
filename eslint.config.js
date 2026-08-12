/**
 * Story 1.18 — the flat config. Linting had NEVER run in this repo.
 *
 * `npm run lint:check` was wired into CI as `continue-on-error: true` against an
 * `eslint .` that exited 2 because no config existed. A step that cannot pass and
 * cannot fail the build is not a gate; it is a green tick that means nothing —
 * the same shape as the `type-check` that checked an empty file set (Story 1.1)
 * and the suite that never ran (attestto-trust, 2026-08-07).
 *
 * ── What this config is for ─────────────────────────────────────────────────
 *
 * Correctness, not style. Formatting arguments are not worth a blocking gate, so
 * every stylistic rule is off and the type-aware rules that catch real defects
 * are on. In a codebase this full of `.then()` chains and `chrome.*` callbacks,
 * `no-floating-promises` and `no-misused-promises` are the two that earn their
 * keep: a dropped rejection in the service worker is a request that hangs
 * forever, and MV3 gives you no stack for it.
 *
 * Everything enabled here is an ERROR. A warning is a finding nobody acts on and
 * a gate that cannot bite, which is what this story exists to remove.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

export default tseslint.config(
  {
    // Generated, vendored, or not ours. `.output` and `.wxt` are WXT build
    // artefacts; linting them would report on code we did not write.
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'public/**',
      '*.min.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...vue.configs['flat/recommended'],

  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        // WXT injects these as build-time globals.
        defineBackground: 'readonly',
        defineContentScript: 'readonly',
      },
      parserOptions: {
        // `projectService` reads the real tsconfig graph, so the type-aware
        // rules see the same types `vue-tsc -b` does. A rule that guesses at
        // types is a rule that reports at random.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        // The TS parser handles `<script setup lang="ts">` inside the SFC.
        parser: tseslint.parser,
      },
    },
  },

  {
    rules: {
      // ── Formatting is not a gate ──────────────────────────────────────────
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',

      // ── The rules that catch real defects ─────────────────────────────────
      // A dropped promise in the service worker is a request that hangs with no
      // stack to find it by.
      '@typescript-eslint/no-floating-promises': 'error',
      // `onClick={async () => …}` against a void-returning handler: the caller
      // cannot await it, so a rejection vanishes.
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'log'] }],

      // An adapter implementing a `Promise`-returning port must be `async` even
      // when its body happens to be synchronous today — that is the port's
      // contract, not an oversight, and `ports.ts` is full of them. 170 findings,
      // none of them defects; leaving it on would bury `no-floating-promises`.
      '@typescript-eslint/require-await': 'off',

      // ── Deliberate loosenings, each with a reason ─────────────────────────
      // The `chrome.*` surface and the wire protocol are `any`-shaped at the
      // boundary; the codebase narrows at the seam rather than at every read.
      // Banning `any` outright here would produce hundreds of findings about
      // code that is already guarded, and drown the two rules above.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // `vue-tsc -b --noEmit` already fails the build on an unused local, and it
      // sees the whole project graph. Two gates reporting the same defect means
      // one of them gets muted.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    // Specs may reach for the shapes production code must not.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.test-d.ts', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },

  {
    // Config files run in Node, not the browser.
    files: ['*.config.{js,ts}', 'wxt.config.ts', 'vitest.config.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },

  {
    // Neither the lint config nor the build scripts are in any tsconfig's
    // `include`, so the project service cannot type them and the type-aware
    // rules report a parse error. Lint them with the untyped rules rather than
    // ignoring them — an unlintable lint config is exactly where a broken gate
    // hides, and `gate-self-test.mjs` is the file that proves the gates work.
    files: ['eslint.config.js', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
)
