/**
 * The first-install setup surface, proven to actually DO something.
 *
 * This file exists because of the defect it pins. The setup call-to-action on
 * this page was written as:
 *
 *     <a to="/setup" target="_blank">Set up your Attestto ID</a>
 *
 * `to` is a `<router-link>` prop on a plain anchor, so Vue rendered a literal
 * attribute and NO `href`. The button was inert. There is no router in this
 * entrypoint and no `/setup` route for it to reach even if there had been.
 *
 * The consequence was not cosmetic. `onInstalled` opens this tab, so it is the
 * first thing the extension shows a new user — and it could not set anything
 * up. The only reachable setup paths were the popup and, worse, a site's
 * approval window, where a 30-second request timeout runs while the user is
 * asked to configure a wallet.
 *
 * A dead link type-checks, lints, and renders. Only a test that CLICKS it and
 * demands a consequence catches this, which is what these do.
 *
 * The Spanish pass is not decoration: strings ship EN/ES and a missing key
 * renders as the key path, so mounting under `es` is how a forgotten
 * translation reddens instead of shipping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import OverviewView from './OverviewView.vue'

const setup = vi.fn()
const loadPublicData = vi.fn()
let publicVault: Record<string, unknown> | null = null

vi.mock('@/utils/pin-store', () => ({ listPins: async () => [] }))
vi.mock('@/utils/vault', () => ({ readPublicVault: async () => publicVault }))
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({
    linkedIdentities: [],
    loadPublicData,
    setup,
  }),
}))

function mountOverview(locale: 'en' | 'es' = 'en') {
  const i18n = createI18n({ legacy: false, locale, messages: { en, es } })
  return mount(OverviewView, { global: { plugins: [i18n] } })
}

/** The CTA, found by what it DOES rather than by a test-only hook. */
function setupButton(wrapper: ReturnType<typeof mountOverview>, label: string) {
  return wrapper
    .findAll('button')
    .find((b) => b.text().includes(label))
}

beforeEach(() => {
  vi.clearAllMocks()
  publicVault = null
  setActivePinia(createPinia())
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    tabs: { getCurrent: vi.fn(), remove: vi.fn() },
  }
})

describe('the first-install page can actually set the wallet up', () => {
  it('🔒 running the setup call-to-action calls wallet.setup()', async () => {
    const wrapper = mountOverview()
    await flushPromises()

    const btn = setupButton(wrapper, en.overview.identity.setup)
    expect(
      btn,
      'no clickable setup control on the first-install page — this is the dead ' +
        '`<a to="/setup">` regression, which renders but cannot be actioned',
    ).toBeDefined()

    await btn!.trigger('click')
    await flushPromises()

    expect(
      setup,
      'the setup control was clicked and nothing happened. The tab that opens on ' +
        'install must be able to complete setup, or the user is pushed into doing ' +
        'it inside a site request that is being timed.',
    ).toHaveBeenCalledTimes(1)
  })

  it('asks for nothing but the passkey', async () => {
    // The whole point of the flow: no password, no recovery phrase, no name, no
    // choices. If an input ever appears here, setup has grown a second step.
    const wrapper = mountOverview()
    await flushPromises()

    expect(wrapper.findAll('input')).toHaveLength(0)
    expect(wrapper.html()).not.toMatch(/type="password"/)
  })

  it('leads with setup before anything else on a fresh install', async () => {
    // "The very first thing it should say is: set up your passkey." Anti-phishing
    // is always-on and needs no user action, so it must not outrank the one
    // thing that does.
    const wrapper = mountOverview()
    await flushPromises()

    const html = wrapper.html()
    expect(html.indexOf(en.overview.identity.setup)).toBeLessThan(
      html.indexOf(en.overview.protection.title),
    )
  })

  it('does not offer setup again once an identity exists', async () => {
    // `setup()` mints a root `did` and NO linked identity. The old predicate
    // here counted only linked identities, so a set-up wallet kept advertising
    // setup — and running it again would replace the vault.
    publicVault = { did: 'did:jwk:abc' }

    const wrapper = mountOverview()
    await flushPromises()

    expect(setupButton(wrapper, en.overview.identity.setup)).toBeUndefined()
    expect(wrapper.text()).toContain(en.overview.identity.activeBody)
  })

  it('renders the Spanish first-run copy', async () => {
    const wrapper = mountOverview('es')
    await flushPromises()

    expect(setupButton(wrapper, es.overview.identity.setup)).toBeDefined()
    // A missing key renders as the dotted path, so this also proves the ES
    // strings exist rather than merely that something rendered.
    expect(wrapper.text()).not.toMatch(/overview\.identity\./)
  })
})

describe('finishing', () => {
  /**
   * The tab used to remove itself 2.5s after success. Closing a tab hands focus
   * to whatever is behind it, so "you are done" and "you are now looking at
   * something unrelated" landed as one event and read as an unexplained
   * redirect. It closes on a click now — same outcome, chosen by the user.
   */
  it('🔒 closes only when the user asks, never on a timer', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountOverview()
      await flushPromises()
      await setupButton(wrapper, en.overview.identity.setup)!.trigger('click')
      await flushPromises()

      const tabs = (globalThis as unknown as { chrome: { tabs: { remove: ReturnType<typeof vi.fn> } } }).chrome.tabs
      vi.advanceTimersByTime(60_000)
      expect(
        tabs.remove,
        'the tab closed itself with no click — that is the focus jump that read as a redirect',
      ).not.toHaveBeenCalled()

      const done = setupButton(wrapper, en.overview.identity.done)
      expect(done, 'success state offers no way out of the tab').toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what the user is told when setup cannot happen', () => {
  it('reports a device without PRF as unsupported, never as needing a password', async () => {
    setup.mockRejectedValueOnce(new Error('PRF_UNSUPPORTED: …'))

    const wrapper = mountOverview()
    await flushPromises()
    await setupButton(wrapper, en.overview.identity.setup)!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(en.overview.identity.unsupported)
    // The failure must not resurrect the passphrase as an escape hatch.
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0)
  })

  it('lets the user retry after cancelling the authenticator', async () => {
    setup.mockRejectedValueOnce(
      Object.assign(new DOMException('cancelled', 'NotAllowedError')),
    )

    const wrapper = mountOverview()
    await flushPromises()
    await setupButton(wrapper, en.overview.identity.setup)!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(en.overview.identity.cancelled)
    // Still actionable — a cancelled Touch ID is not a dead end.
    expect(setupButton(wrapper, en.overview.identity.setup)?.attributes('disabled')).toBeUndefined()
  })
})
