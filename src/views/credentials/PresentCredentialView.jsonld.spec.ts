/**
 * Story 1.17 — the JSON-LD over-share fix, proven at the CALL SITE.
 *
 * `jsonld-disclosure.spec` proves the filter. This proves the screen actually
 * uses it: mount the real view, untick a claim, press Generate, and read the
 * JWS that came out. The referent is the emitted presentation — the bytes a
 * verifier would receive — not the view's own `selectedClaims` computed, which
 * is the view agreeing with itself.
 *
 * This is the test the AC's mutation targets: flip the filter to pass-through
 * and the withheld claim reappears in the payload here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/i18n/locales/en'

const HOLDER = 'did:jwk:holder-abc'

const RAW_VC = JSON.stringify({
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:cred-1',
  type: ['VerifiableCredential', 'IdentityCredential'],
  issuer: 'did:web:gob.cr',
  issuanceDate: '2026-01-01T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    fullName: 'Jane Q Public',
    nationalId: 'LEAK-CEDULA',
    salary: 'LEAK-SALARY',
  },
  proof: { type: 'Ed25519Signature2020', jws: 'LEAK-ISSUER-SIGNATURE' },
})

const JSON_LD_CRED = {
  id: 'cred-1',
  format: 'json-ld' as const,
  raw: RAW_VC,
  issuer: 'did:web:gob.cr',
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  types: ['VerifiableCredential', 'IdentityCredential'],
  // For JSON-LD this IS the credentialSubject — see credential-offer-accept.
  decodedClaims: {
    id: HOLDER,
    fullName: 'Jane Q Public',
    nationalId: 'LEAK-CEDULA',
    salary: 'LEAK-SALARY',
  },
  metadata: { addedAt: '2026-01-01T00:00:00Z', source: 'push' as const },
}

vi.mock('@/stores/credentials', () => ({
  useCredentialsStore: () => ({ getById: () => JSON_LD_CRED }),
}))
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({
    isUnlocked: true,
    did: HOLDER,
    getPrivateKey: () => ({ kty: 'EC', crv: 'P-256', d: 'LEAK-PRIVATE-KEY', x: 'x', y: 'y' }),
  }),
}))
// A signer that does not need real WebCrypto. The signature value is irrelevant
// here; the PAYLOAD is what this suite reads.
vi.mock('@/services/jws', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/jws')>()),
  es256KeySigner: () => async () => 'test-signature',
}))

import PresentCredentialView from './PresentCredentialView.vue'

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/credentials/:id/present', component: PresentCredentialView },
      { path: '/credentials', component: { template: '<div/>' } },
    ],
  })
  void router.push('/credentials/cred-1/present')
  await router.isReady()
  const wrapper = mount(PresentCredentialView, {
    global: { plugins: [router, createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountView>>

function claimRow(wrapper: Wrapper, name: string) {
  return wrapper.findAll('label').find((l) => l.text().includes(name))
}

async function untick(wrapper: Wrapper, name: string) {
  await claimRow(wrapper, name)!.find('input[type="checkbox"]').setValue(false)
}

/** Fill the nonce, press Generate, and decode the JWS payload that came out. */
async function generate(wrapper: Wrapper) {
  await wrapper.find('input[type="text"]').setValue('verifier-nonce')
  const button = wrapper.findAll('button').find((b) => b.text().includes('Generate'))!
  await button.trigger('click')
  await flushPromises()

  // The rendered <pre> IS the presentation — the same string the copy button
  // puts on the clipboard. Reading it here means the assertions are on what the
  // user can actually hand to a verifier.
  const jws = wrapper.find('pre').text()
  const [, encoded] = jws.split('.')
  const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')))

  // `serialized` is what the leak assertions read. Searching the JWS itself for
  // a plaintext sentinel is VACUOUS — the payload is base64url, so the plaintext
  // never appears in it and the check can never fail. The pass-through mutation
  // is what exposed that; the decoded payload is the only honest referent.
  return { jws, payload, serialized: JSON.stringify(payload) }
}

beforeEach(() => setActivePinia(createPinia()))

describe('the screen offers a choice at all', () => {
  it('lists every JSON-LD claim as a checkbox — it used to say "All claims will be shared"', async () => {
    const wrapper = await mountView()
    const names = wrapper.findAll('input[type="checkbox"]').length
    // fullName, nationalId, salary. `id` is the holder binding, not a tradeable claim.
    expect(names).toBe(3)
    expect(wrapper.text()).not.toContain('All claims will be shared')
  })

  it('will not generate with nothing selected — no accidental empty presentation', async () => {
    const wrapper = await mountView()
    for (const box of wrapper.findAll('input[type="checkbox"]')) await box.setValue(false)
    await wrapper.find('input[type="text"]').setValue('verifier-nonce')

    const button = wrapper.findAll('button').find((b) => b.text().includes('Generate'))!
    expect(button.attributes('disabled')).toBeDefined()
  })
})

/**
 * 🛑 REWRITTEN 2026-08-09. Partial disclosure on JSON-LD is now REFUSED rather
 * than emitted as a proof-stripped derivation.
 *
 * The three tests replaced here asserted the old behaviour: untick a claim,
 * generate, and the withheld value is absent while the issuer proof is dropped.
 * That was correct for the code as it stood. It is not what we do now, and
 * adapting them would leave a suite describing a product that no longer exists.
 *
 * ⚠️ THIS SCREEN NEEDS UI WORK. It still renders a checkbox per claim, so a user
 * can untick one, press Generate, and hit an error. Refusing at generate time is
 * safer than emitting an unverifiable credential, but it is not the intended
 * experience: the checkboxes should be disabled (or the format flagged) for
 * JSON-LD credentials so the user is never offered a choice we cannot honour.
 * Tracked with the SD-JWT format work.
 */
describe('an unselected claim is refused rather than silently downgraded', () => {
  /** Press Generate without assuming a presentation came out. */
  async function tryGenerate(wrapper: Wrapper) {
    await wrapper.find('input[type="text"]').setValue('verifier-nonce')
    const button = wrapper.findAll('button').find((b) => b.text().includes('Generate'))!
    await button.trigger('click')
    await flushPromises()
    return wrapper
  }

  it('🛑 unticking a claim shows an error instead of emitting a derivation', async () => {
    const wrapper = await mountView()
    await untick(wrapper, 'nationalId')
    await tryGenerate(wrapper)

    // The view catches and surfaces it rather than crashing — the user is told
    // at the moment they act, which is the whole point of refusing.
    expect(wrapper.text()).toContain('Partial disclosure is not supported')
  })

  it('🔒 no presentation is rendered at all when it refuses', async () => {
    const wrapper = await mountView()
    await untick(wrapper, 'nationalId')
    await untick(wrapper, 'salary')
    await tryGenerate(wrapper)

    // The referent: the <pre> that holds the presentation does not exist, so
    // there is nothing a user could copy to a verifier.
    //
    // Note the assertion is scoped to that element, NOT to wrapper.text(). The
    // claim picker renders the user's own values on their own screen, so the
    // sentinels legitimately appear there — a whole-page scan would fail for a
    // reason that has nothing to do with disclosure.
    expect(wrapper.find('pre').exists()).toBe(false)
  })

  it('POSITIVE CONTROL: keeping every claim still generates, proof intact', async () => {
    const wrapper = await mountView()
    const { payload, serialized } = await generate(wrapper)

    const vc = payload.vp.verifiableCredential[0]
    expect(vc.credentialSubject.fullName).toBe('Jane Q Public')
    // The whole point of refusing: the issuer signature survives.
    expect(vc.proof).toBeDefined()
    expect(serialized).not.toContain('LEAK-PRIVATE-KEY')
  })

  it('never emits the private key, whatever is selected', async () => {
    const wrapper = await mountView()
    const { serialized } = await generate(wrapper)
    expect(serialized).not.toContain('LEAK-PRIVATE-KEY')
  })
})

describe('the cost of withholding is shown before the user commits', () => {
  it('warns once a claim is unticked', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="derived-warning"]').exists()).toBe(false)

    await untick(wrapper, 'salary')

    expect(wrapper.find('[data-testid="derived-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="derived-warning"]').text()).toMatch(/issuer/i)
  })

  it('does not warn when everything is shared — that VC is still fully verifiable', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="derived-warning"]').exists()).toBe(false)
  })

  it('withdraws the warning if the user re-ticks the claim', async () => {
    const wrapper = await mountView()
    await untick(wrapper, 'salary')
    await claimRow(wrapper, 'salary')!.find('input[type="checkbox"]').setValue(true)

    expect(wrapper.find('[data-testid="derived-warning"]').exists()).toBe(false)
  })
})

describe('sharing everything keeps the issuer signature', () => {
  it('the full credential goes out untouched, proof included', async () => {
    const wrapper = await mountView()
    const { payload } = await generate(wrapper)
    const vc = payload.vp.verifiableCredential[0]

    expect(vc.proof).toEqual({ type: 'Ed25519Signature2020', jws: 'LEAK-ISSUER-SIGNATURE' })
    expect(vc.credentialSubject.nationalId).toBe('LEAK-CEDULA')
    expect(vc.type).not.toContain('DerivedCredential')
  })
})
