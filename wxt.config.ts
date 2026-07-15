import { defineConfig } from 'wxt'
import tailwindcss from '@tailwindcss/vite' // 1. Import the plugin


export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-vue'],

  // Vite config shared across all entrypoints
  vite: () => ({
    plugins: [
      tailwindcss(), // 2. Add the plugin here
    ],
    resolve: {
      alias: {},
    },
  }),

  manifest: {
    name: 'Attestto ID',
    description:
      'Digital ID agent — passkey-secured vault, verifiable credentials, DID-authenticated payments, and privacy-preserving presentations.',
    version: '0.1.0',

    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'notifications',
      'offscreen',
      'alarms',
      'webNavigation',
    ],

    host_permissions: [
      // CR public-sector zones — scope for the in-page gov TLS trust bar
      // (trust-bar.content.ts). Deliberately NOT <all_urls>.
      '*://*.go.cr/*',
      '*://*.fi.cr/*',
      '*://*.sa.cr/*',
      '*://*.ac.cr/*',
      '*://*.ed.cr/*',
      '*://*.or.cr/*',
    ],

    web_accessible_resources: [
      {
        resources: ['assets/*', 'offscreen/index.html', 'wallet-discovery.js', 'icon/*', 'data/*'],
        matches: ['<all_urls>'],
      },
    ],

    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },

    // Open Settings in a real browser tab — never embedded inside the
    // extensions manager modal. Matches the LastPass dedicated-page pattern
    // Eduardo flagged 2026-06-29 (chrome-extension://*/options.html as a
    // full surface, not a 600px modal).
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },

    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
})
