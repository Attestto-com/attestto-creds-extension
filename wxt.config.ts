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
    name: 'Attestto Creds',
    description:
      'Self-sovereign identity wallet — verifiable credentials, selective disclosure, and anti-phishing protection.',
    version: '0.1.0',

    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'notifications',
      'offscreen',
      'alarms',
    ],

    host_permissions: [],

    web_accessible_resources: [
      {
        resources: ['assets/*', 'offscreen/index.html', 'wallet-discovery.js', 'icon/*'],
        matches: ['<all_urls>'],
      },
    ],

    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },

    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
})
