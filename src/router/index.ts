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
      name: 'home',
      component: () => import('@/views/home/HomeView.vue'),
    },
    {
      /**
       * Wallet setup / unlock.
       *
       * `LockScreenView` is the ONLY caller of `wallet.setup()`, and until now
       * it was not routed and nothing imported it — so the vault could not be
       * set up from the popup at all. The only working setup paths were in the
       * approval window, reached when a SITE triggered a signing request, which
       * meant a fresh profile had no way to create a wallet on its own.
       *
       * ATT-724 removed the setup GATE from the popup deliberately. Removing
       * the gate was right; leaving no entry point was not.
       */
      path: '/setup',
      name: 'setup',
      component: () => import('@/views/lock/LockScreenView.vue'),
    },
    {
      path: '/identities',
      name: 'identity-list',
      component: () => import('@/views/identity/IdentityListView.vue'),
    },
    {
      path: '/identity/:did',
      name: 'identity-detail',
      component: () => import('@/views/identity/IdentityDetailView.vue'),
    },
    {
      path: '/credentials',
      name: 'credentials',
      component: () => import('@/views/credentials/CredentialsView.vue'),
    },
    {
      path: '/inbox',
      name: 'inbox',
      component: () => import('@/views/inbox/InboxView.vue'),
    },
    {
      path: '/tls',
      name: 'tls-detail',
      component: () => import('@/views/site/TlsDetailView.vue'),
    },
    {
      path: '/site-profile',
      name: 'site-profile',
      component: () => import('@/views/site/SiteProfileView.vue'),
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
      path: '/chapi-consent',
      name: 'chapi-consent',
      component: () => import('@/views/consent/ChapiConsentView.vue'),
    },
  ],
})

export default router
