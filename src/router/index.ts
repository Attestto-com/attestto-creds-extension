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
