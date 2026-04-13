import { createRouter, createMemoryHistory } from 'vue-router'

/**
 * Popup router uses memory history (no URL bar in extension popups).
 * Each "page" is a panel rendered inside the fixed-size popup window.
 */
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      name: 'wallet',
      component: () => import('@/views/wallet/WalletView.vue'),
    },
    {
      path: '/credentials',
      name: 'credentials',
      component: () => import('@/views/credentials/CredentialsView.vue'),
    },
    {
      path: '/credentials/:id/present',
      name: 'present-credential',
      component: () => import('@/views/credentials/PresentCredentialView.vue'),
    },
    {
      path: '/credentials/prepared',
      name: 'prepared-presentations',
      component: () => import('@/views/credentials/PreparedPresentationsView.vue'),
    },
    {
      path: '/consent/:id',
      name: 'proof-consent',
      component: () => import('@/views/consent/ProofConsentView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/settings/SettingsView.vue'),
    },
    {
      path: '/chapi-consent',
      name: 'chapi-consent',
      component: () => import('@/views/consent/ChapiConsentView.vue'),
    },
  ],
})

export default router
