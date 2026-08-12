/**
 * SiteProfileView — component tests.
 *
 * Covers the two key render branches:
 *   1. Registry-matched host: identity section shows institution name,
 *      "Known institution" badge, and TlsCertificateCard when in snapshot.
 *   2. Unknown host: neutral badge shown, no TlsCertificateCard,
 *      empty-state CTA shown instead (with scan button disabled).
 *
 * Chrome APIs and utility modules are mocked at the module level so this
 * test runs in happy-dom without a real extension environment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import SiteProfileView from './SiteProfileView.vue'
import type { TlsSnapshotRow } from '@/utils/tls-snapshot'

// ── Chrome API stub ──────────────────────────────────────────────────────────
// happy-dom has no chrome global; provide a minimal shim for the tabs query.
const mockTab = {
  url: 'https://bccr.fi.cr/pagina',
  favIconUrl: 'https://bccr.fi.cr/favicon.ico',
}

Object.defineProperty(globalThis, 'chrome', {
  value: {
    tabs: {
      query: vi.fn().mockResolvedValue([mockTab]),
    },
    runtime: {
      getURL: vi.fn((p: string) => `chrome-extension://fake/${p}`),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, host: 'bccr.fi.cr', ca: 'DigiCert', validationTier: 'EV', daysToExpiry: 180, expired: false }),
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([{ result: null }]),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  },
  writable: true,
})

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockTlsRow: TlsSnapshotRow = {
  host: 'bccr.fi.cr',
  ok: true,
  error: null,
  ca: 'DigiCert',
  validationTier: 'EV',
  isFreeCA: false,
  expired: false,
  daysToExpiry: 180,
  issuerCommonName: 'DigiCert EV RSA CA G2',
  issuerOrganization: 'DigiCert Inc',
  isOrganizationValidated: true,
  subjectCommonName: 'bccr.fi.cr',
  subjectAltNames: ['bccr.fi.cr'],
  validFrom: '2026-01-01T00:00:00Z',
  sha256: 'aa:bb:cc',
  validTo: '2026-12-31T00:00:00Z',
}

vi.mock('@/utils/tls-snapshot', () => ({
  lookupTls: vi.fn().mockResolvedValue(null),
  snapshotDate: vi.fn().mockReturnValue('2026-07-01'),
}))

vi.mock('@/utils/trust-registry', () => ({
  lookupHost: vi.fn().mockResolvedValue(null),
  brandLabelFromHost: vi.fn().mockReturnValue(null),
}))

vi.mock('@/utils/gov-host', () => ({
  isGovHost: vi.fn().mockReturnValue(false),
}))

vi.mock('@/utils/homograph', () => ({
  homographState: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/utils/pin-store', () => ({
  isPinned: vi.fn().mockResolvedValue(false),
}))

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div/>' } },
      { path: '/site-profile', name: 'site-profile', component: SiteProfileView },
    ],
  })
}

async function mountView() {
  const router = makeRouter()
  await router.push('/site-profile')
  await router.isReady()
  const wrapper = mount(SiteProfileView, {
    global: {
      plugins: [router, makeI18n()],
    },
  })
  await flushPromises()
  return wrapper
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SiteProfileView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset chrome.tabs.query to default (bccr.fi.cr)
    ;(globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([mockTab])
  })

  describe('registry-matched host with TLS snapshot', () => {
    beforeEach(async () => {
      const { lookupHost } = await import('@/utils/trust-registry')
      const { lookupTls } = await import('@/utils/tls-snapshot')
      const { isGovHost } = await import('@/utils/gov-host')
      ;(lookupHost as ReturnType<typeof vi.fn>).mockResolvedValue({
        host: 'bccr.fi.cr',
        name: 'BCCR',
        category: 'Banco Central',
      })
      ;(lookupTls as ReturnType<typeof vi.fn>).mockResolvedValue(mockTlsRow)
      ;(isGovHost as ReturnType<typeof vi.fn>).mockReturnValue(true)
    })

    it('renders the institution name', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain('BCCR')
    })

    it('shows the "Known institution" badge', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.siteProfile.registryVerified)
    })

    it('shows the "CR government site" badge', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.siteProfile.govHost)
    })

    it('renders TlsCertificateCard when host is in snapshot', async () => {
      const wrapper = await mountView()
      // TlsCertificateCard renders the CA name from the tls prop
      expect(wrapper.text()).toContain('DigiCert')
    })

    it('does NOT render the empty-state scan CTA', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).not.toContain(en.siteProfile.tlsNoSnapshot)
      expect(wrapper.text()).not.toContain(en.siteProfile.scanThisSite)
    })

    it('renders a back button', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.common.back)
    })
  })

  describe('unknown host NOT in snapshot', () => {
    beforeEach(async () => {
      const { lookupHost } = await import('@/utils/trust-registry')
      const { lookupTls } = await import('@/utils/tls-snapshot')
      const { isGovHost } = await import('@/utils/gov-host')
      ;(lookupHost as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(lookupTls as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(isGovHost as ReturnType<typeof vi.fn>).mockReturnValue(false)
      ;(globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        { url: 'https://example.com/', favIconUrl: null },
      ])
    })

    it('shows the host domain', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain('example.com')
    })

    it('shows "Not yet evaluated" when no signals match', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.siteProfile.notYetEvaluated)
    })

    it('shows the empty-state TLS message', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.siteProfile.tlsNoSnapshot)
    })

    it('renders the scan CTA button as enabled (live scan available)', async () => {
      const wrapper = await mountView()
      // Find a button containing the scan label that is NOT disabled
      const buttons = wrapper.findAll('button')
      const scanBtn = buttons.find((b) => b.text().includes(en.siteProfile.scanThisSite))
      expect(scanBtn?.exists()).toBe(true)
      expect(scanBtn?.attributes('disabled')).toBeUndefined()
    })

    it('does NOT render TlsCertificateCard', async () => {
      const wrapper = await mountView()
      // TlsCertificateCard is absent — the CA row is not rendered
      expect(wrapper.text()).not.toContain('DigiCert')
    })

    it('calls chrome.runtime.sendMessage with CERT_SCAN_REQUEST on scan click', async () => {
      const wrapper = await mountView()
      const buttons = wrapper.findAll('button')
      const scanBtn = buttons.find((b) => b.text().includes(en.siteProfile.scanThisSite))
      await scanBtn?.trigger('click')
      expect(globalThis.chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CERT_SCAN_REQUEST' }),
      )
    })

    it('shows CA and validation tier after a successful scan', async () => {
      const wrapper = await mountView()
      const buttons = wrapper.findAll('button')
      const scanBtn = buttons.find((b) => b.text().includes(en.siteProfile.scanThisSite))
      await scanBtn?.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('DigiCert')
      expect(wrapper.text()).toContain('EV')
    })

    it('shows scan error when backend returns ok:false', async () => {
      ;(globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        host: 'example.com',
        error: 'timeout',
      })
      const wrapper = await mountView()
      const buttons = wrapper.findAll('button')
      const scanBtn = buttons.find((b) => b.text().includes(en.siteProfile.scanThisSite))
      await scanBtn?.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain(en.siteProfile.scanError)
    })
  })

  describe('brand-squat host', () => {
    beforeEach(async () => {
      const { homographState } = await import('@/utils/homograph')
      const { lookupHost } = await import('@/utils/trust-registry')
      const { lookupTls } = await import('@/utils/tls-snapshot')
      ;(lookupHost as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(lookupTls as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(homographState as ReturnType<typeof vi.fn>).mockResolvedValue('red')
      ;(globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        { url: 'https://bccr.online/', favIconUrl: null },
      ])
    })

    it('shows the brand-squat warning', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.siteProfile.brandSquatWarning)
    })
  })

  describe('no active HTTP/S tab', () => {
    beforeEach(() => {
      ;(globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        { url: 'chrome://extensions/', favIconUrl: null },
      ])
    })

    it('shows the no-site message', async () => {
      const wrapper = await mountView()
      expect(wrapper.text()).toContain(en.home.currentSite.noSite)
    })
  })
})
