/**
 * Story 1.14 — the auto-lock control, proven at the call site.
 *
 * `idle-lock.spec` proves the timer; `settings-config.spec` proves the storage
 * shape. Neither proves the thing a user touches. This mounts the real
 * `SecurityView` with the real locale files and asserts against what lands in
 * `chrome.storage.sync` — the same value the background reads. A spy on
 * `writeSettings` would pass even if the button wrote to nothing.
 *
 * The Spanish pass is not decoration: the strings ship EN/ES (NFR-6), and a
 * missing key renders as the key path, so mounting under `es` is how a forgotten
 * translation reddens instead of shipping.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/i18n/locales/en'
import es from '@/i18n/locales/es'
import { AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK_MINUTES } from '@/utils/settings-config'
import SecurityView from './SecurityView.vue'

vi.mock('@/utils/vault', () => ({ readPublicVault: async () => ({ siteDids: {} }) }))
vi.mock('@/stores/wallet', () => ({
  useWalletStore: () => ({ isUnlocked: true, unlock: vi.fn(), archiveSiteDid: vi.fn() }),
}))

const SETTINGS_KEY = 'attestto_settings'
let synced: Record<string, unknown>

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  synced = {}
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: {
      sync: {
        get: async (key: string) => (key in synced ? { [key]: synced[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          synced = { ...synced, ...entries }
        },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  }
})

async function mountView(locale: 'en' | 'es' = 'en') {
  const wrapper = mount(SecurityView, {
    global: {
      plugins: [createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, es } })],
    },
  })
  await flushPromises()
  return wrapper
}

/** The buttons of the auto-lock section, identified by their aria-pressed role. */
function lockButtons(wrapper: Awaited<ReturnType<typeof mountView>>) {
  return wrapper.findAll('button[aria-pressed]')
}

describe('the auto-lock control', () => {
  it('offers every choice and no "never"', async () => {
    const wrapper = await mountView()
    const labels = lockButtons(wrapper).map((b) => b.text())

    expect(labels).toEqual(['1 minute', '5 minutes', '15 minutes', '30 minutes'])
    expect(labels.join(' ').toLowerCase()).not.toContain('never')
  })

  it('starts on the secure default with nothing stored', async () => {
    const wrapper = await mountView()
    const pressed = lockButtons(wrapper).filter((b) => b.attributes('aria-pressed') === 'true')

    expect(pressed).toHaveLength(1)
    expect(pressed[0].text()).toBe(`${DEFAULT_AUTO_LOCK_MINUTES} minutes`)
  })

  it('writes the chosen timeout to the storage the background reads', async () => {
    const wrapper = await mountView()
    await lockButtons(wrapper)[0].trigger('click') // 1 minute

    await vi.advanceTimersByTimeAsync(300) // the save debounce
    await flushPromises()

    expect((synced[SETTINGS_KEY] as { autoLockMinutes: number }).autoLockMinutes).toBe(1)
  })

  it('reflects a stored choice on load rather than resetting it', async () => {
    synced[SETTINGS_KEY] = { autoLockMinutes: 30 }
    const wrapper = await mountView()
    const pressed = lockButtons(wrapper).filter((b) => b.attributes('aria-pressed') === 'true')

    expect(pressed[0].text()).toBe('30 minutes')
  })

  it('falls back to the default when storage holds a value we do not offer', async () => {
    // e.g. an older build that allowed 0, or a hand-edited profile.
    synced[SETTINGS_KEY] = { autoLockMinutes: 0 }
    const wrapper = await mountView()
    const pressed = lockButtons(wrapper).filter((b) => b.attributes('aria-pressed') === 'true')

    expect(pressed[0].text()).toBe(`${DEFAULT_AUTO_LOCK_MINUTES} minutes`)
  })

  it('renders in Spanish — a missing key would render its own path', async () => {
    const wrapper = await mountView('es')
    const labels = lockButtons(wrapper).map((b) => b.text())

    expect(labels).toEqual(['1 minuto', '5 minutos', '15 minutos', '30 minutos'])
    expect(wrapper.text()).toContain('Bloquear la billetera')
    expect(wrapper.text()).not.toContain('security.autoLock')
  })

  it('the section covers every choice the config exports — no drift', async () => {
    const wrapper = await mountView()
    expect(lockButtons(wrapper)).toHaveLength(AUTO_LOCK_CHOICES.length)
  })
})
