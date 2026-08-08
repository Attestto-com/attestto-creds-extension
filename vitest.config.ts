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
    },
  },
})
