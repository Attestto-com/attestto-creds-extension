/**
 * Story 1.8 — FR9 enforcement, the RENDERED-badge referent.
 *
 * The policy unit test (identity-disclosure.spec) proves the tier values; THIS
 * test proves the WIRING — that a sensitive claim actually renders the badge in
 * `PresentCredentialView`, and a standard one does not. Together with the policy
 * mutation, flipping a tier reddens the visible badge (Murat: prove the call
 * site, not the function in isolation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/i18n/locales/en'

// ── mock the SD-JWT service: two claims, one sensitive (nationalId.number),
//    one standard (fullName) ────────────────────────────────────────────────
vi.mock('@/services/sdjwt', () => ({
  parseSdJwt: vi.fn(async () => ({ disclosures: ['d1', 'd2'] })),
  decodeDisclosures: vi.fn(() => [
    { salt: 's1', claimName: 'nationalId.number', claimValue: '1-1100-0999' },
    { salt: 's2', claimName: 'fullName', claimValue: 'Jane Q Public' },
  ]),
  createSdJwtPresentation: vi.fn(),
}))

const SD_JWT_CRED = {
  id: 'cred-1',
  format: 'sd-jwt' as const,
  raw: 'header.payload.sig~d1~d2',
  issuer: 'https://gob.cr',
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  types: ['VerifiableCredential', 'IdentityVC'],
  decodedClaims: {},
  metadata: { addedAt: '2026-01-01T00:00:00Z', source: 'push' as const },
}

vi.mock('@/stores/credentials', () => ({
  useCredentialsStore: () => ({ getById: (_id: string) => SD_JWT_CRED }),
}))
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({ isUnlocked: true }),
}))

import PresentCredentialView from './PresentCredentialView.vue'

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}
function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/credentials/:id/present', name: 'present', component: PresentCredentialView },
      { path: '/credentials', name: 'creds', component: { template: '<div/>' } },
    ],
  })
  return router
}

async function mountAt() {
  const router = makeRouter()
  void router.push('/credentials/cred-1/present')
  await router.isReady()
  const wrapper = mount(PresentCredentialView, { global: { plugins: [router, makeI18n()] } })
  await flushPromises()
  return wrapper
}

describe('PresentCredentialView — sensitive-field badge (FR9 wiring)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders a Sensitive badge for the sensitive claim and NOT for the standard one', async () => {
    const wrapper = await mountAt()
    const badges = wrapper.findAll('[data-testid="sensitive-badge"]')
    // Exactly one sensitive claim (nationalId.number); fullName is standard.
    expect(badges).toHaveLength(1)
    // The badge sits on the sensitive claim's row, not the standard one.
    const sensitiveRow = wrapper.findAll('label').find((l) => l.text().includes('nationalId.number'))
    expect(sensitiveRow?.find('[data-testid="sensitive-badge"]').exists()).toBe(true)
    const standardRow = wrapper.findAll('label').find((l) => l.text().includes('fullName'))
    expect(standardRow?.find('[data-testid="sensitive-badge"]').exists()).toBe(false)
  })
})
