/**
 * SiteHealthPanel — component tests.
 *
 * Verifies that all four stat groups render correctly for both
 * a clean HTTPS result and a problematic result with issues.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'
import SiteHealthPanel from './SiteHealthPanel.vue'
import type { SiteHealthResult } from '@/utils/site-health'

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

const CLEAN_RESULT: SiteHealthResult = {
  security: {
    isHttps: true,
    mixedContentCount: 0,
    unsafeFormCount: 0,
    passwordOnHttp: false,
    blankNoOpenerCount: 0,
  },
  a11y: {
    imgMissingAlt: 0,
    imgTotal: 3,
    inputMissingLabel: 0,
    missingHtmlLang: false,
    h1Count: 1,
    headingLevelsSkipped: false,
    hasAriaLandmarks: true,
  },
  meta: {
    hasTitle: true,
    titleLength: 42,
    hasMetaDescription: true,
    hasCanonical: true,
    hasFavicon: true,
    hasOpenGraph: true,
  },
  links: {
    totalLinks: 12,
    internalLinks: 8,
    externalLinks: 4,
    insecureLinks: 0,
  },
  comments: { total: 0, flaggedCount: 0, samples: [] },
  thirdPartyLinks: { internalCount: 0, externalCount: 0, govCount: 0, nonGovExternalCount: 0, thirdPartyResourceCount: 0, govHostWithNonGovResources: false },
  scripts: { externalFirstParty: 0, externalThirdParty: 0, externalThirdPartyNonGov: 0, inlineCount: 0, govHostWithNonGovScripts: false },
  techStack: { detectedPlatforms: [], jsFramework: null, versionDisclosed: false, outdatedHint: false, generatorMetaValue: null },
}

const PROBLEM_RESULT: SiteHealthResult = {
  security: {
    isHttps: false,
    mixedContentCount: 0,
    unsafeFormCount: 2,
    passwordOnHttp: true,
    blankNoOpenerCount: 3,
  },
  a11y: {
    imgMissingAlt: 5,
    imgTotal: 7,
    inputMissingLabel: 2,
    missingHtmlLang: true,
    h1Count: 0,
    headingLevelsSkipped: true,
    hasAriaLandmarks: false,
  },
  meta: {
    hasTitle: false,
    titleLength: 0,
    hasMetaDescription: false,
    hasCanonical: false,
    hasFavicon: false,
    hasOpenGraph: false,
  },
  links: {
    totalLinks: 20,
    internalLinks: 10,
    externalLinks: 10,
    insecureLinks: 4,
  },
  comments: { total: 0, flaggedCount: 0, samples: [] },
  thirdPartyLinks: { internalCount: 0, externalCount: 0, govCount: 0, nonGovExternalCount: 0, thirdPartyResourceCount: 0, govHostWithNonGovResources: false },
  scripts: { externalFirstParty: 0, externalThirdParty: 0, externalThirdPartyNonGov: 0, inlineCount: 0, govHostWithNonGovScripts: false },
  techStack: { detectedPlatforms: [], jsFramework: null, versionDisclosed: false, outdatedHint: false, generatorMetaValue: null },
}

function mountPanel(health: SiteHealthResult) {
  return mount(SiteHealthPanel, {
    props: { health },
    global: { plugins: [makeI18n()] },
  })
}

describe('SiteHealthPanel', () => {
  describe('clean HTTPS site', () => {
    it('shows the disclosure note', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain(en.siteHealth.localAnalysisNote)
    })

    it('renders the Security group', () => {
      const w = mountPanel(CLEAN_RESULT)
      // CSS uppercase is visual-only; DOM text is the raw i18n string
      expect(w.text()).toContain(en.siteHealth.security.title)
    })

    it('shows HTTPS as yes', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain(en.siteHealth.security.https)
      expect(w.text()).toContain(en.siteHealth.yes)
    })

    it('shows None for mixed content', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain(en.siteHealth.none)
    })

    it('renders the Accessibility group', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain(en.siteHealth.a11y.title)
    })

    it('shows h1 count of 1', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain('1')
    })

    it('renders the Meta group', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain(en.siteHealth.meta.title)
    })

    it('shows title length chars', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain('42')
      expect(w.text()).toContain(en.siteHealth.meta.chars)
    })

    it('renders the Links group', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain(en.siteHealth.links.title)
    })

    it('shows link counts', () => {
      const w = mountPanel(CLEAN_RESULT)
      expect(w.text()).toContain('12') // total
      expect(w.text()).toContain('8')  // internal
      expect(w.text()).toContain('4')  // external
    })

    it('shows no insecure links', () => {
      const w = mountPanel(CLEAN_RESULT)
      // insecureLinks = 0 → shows "None"
      expect(w.text()).toContain(en.siteHealth.none)
    })
  })

  describe('site with problems', () => {
    it('shows HTTPS as No', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain(en.siteHealth.no)
    })

    it('shows password on HTTP warning', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain(en.siteHealth.security.passwordOnHttp)
      expect(w.text()).toContain(en.siteHealth.yes)
    })

    it('shows unsafe form count', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain('2')
    })

    it('shows blank-no-opener count', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain('3')
    })

    it('shows missing alt images as fraction', () => {
      const w = mountPanel(PROBLEM_RESULT)
      // 5 / 7 format
      expect(w.text()).toContain('5')
      expect(w.text()).toContain('7')
    })

    it('shows html lang as missing', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain(en.siteHealth.missing)
    })

    it('shows heading skip warning', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain(en.siteHealth.a11y.headingSkip)
    })

    it('shows meta title as missing', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain(en.siteHealth.missing)
    })

    it('shows insecure link count', () => {
      const w = mountPanel(PROBLEM_RESULT)
      expect(w.text()).toContain('4')
    })
  })
})

const SUPPLY_CHAIN_RESULT: SiteHealthResult = {
  security: { isHttps: true, mixedContentCount: 0, unsafeFormCount: 0, passwordOnHttp: false, blankNoOpenerCount: 0 },
  a11y: { imgMissingAlt: 0, imgTotal: 0, inputMissingLabel: 0, missingHtmlLang: false, h1Count: 1, headingLevelsSkipped: false, hasAriaLandmarks: true },
  meta: { hasTitle: true, titleLength: 20, hasMetaDescription: false, hasCanonical: false, hasFavicon: false, hasOpenGraph: false },
  links: { totalLinks: 0, internalLinks: 0, externalLinks: 0, insecureLinks: 0 },
  comments: { total: 0, flaggedCount: 0, samples: [] },
  thirdPartyLinks: { internalCount: 0, externalCount: 0, govCount: 0, nonGovExternalCount: 0, thirdPartyResourceCount: 0, govHostWithNonGovResources: false },
  scripts: { externalFirstParty: 1, externalThirdParty: 2, externalThirdPartyNonGov: 2, inlineCount: 1, govHostWithNonGovScripts: true },
  techStack: { detectedPlatforms: [], jsFramework: null, versionDisclosed: false, outdatedHint: false, generatorMetaValue: null },
}

const TECH_STACK_RESULT: SiteHealthResult = {
  security: { isHttps: true, mixedContentCount: 0, unsafeFormCount: 0, passwordOnHttp: false, blankNoOpenerCount: 0 },
  a11y: { imgMissingAlt: 0, imgTotal: 0, inputMissingLabel: 0, missingHtmlLang: false, h1Count: 1, headingLevelsSkipped: false, hasAriaLandmarks: false },
  meta: { hasTitle: true, titleLength: 20, hasMetaDescription: false, hasCanonical: false, hasFavicon: false, hasOpenGraph: false },
  links: { totalLinks: 0, internalLinks: 0, externalLinks: 0, insecureLinks: 0 },
  comments: { total: 0, flaggedCount: 0, samples: [] },
  thirdPartyLinks: { internalCount: 0, externalCount: 0, govCount: 0, nonGovExternalCount: 0, thirdPartyResourceCount: 0, govHostWithNonGovResources: false },
  scripts: { externalFirstParty: 0, externalThirdParty: 0, externalThirdPartyNonGov: 0, inlineCount: 0, govHostWithNonGovScripts: false },
  techStack: { detectedPlatforms: ['wordpress'], jsFramework: null, versionDisclosed: true, outdatedHint: false, generatorMetaValue: 'WordPress 5.9.3' },
}

describe('supply chain section', () => {
  it('renders the supply chain section', () => {
    const w = mountPanel(SUPPLY_CHAIN_RESULT)
    expect(w.text()).toContain(en.siteHealth.supplyChain.title)
  })

  it('shows non-gov scripts on gov host warning when govHostWithNonGovScripts is true', () => {
    const w = mountPanel(SUPPLY_CHAIN_RESULT)
    expect(w.text()).toContain(en.siteHealth.supplyChain.nonGovScriptsOnGov)
  })
})

describe('page internals section', () => {
  it('renders the page internals section', () => {
    const w = mountPanel(TECH_STACK_RESULT)
    expect(w.text()).toContain(en.siteHealth.pageInternals.title)
  })

  it('shows detected platforms including wordpress', () => {
    const w = mountPanel(TECH_STACK_RESULT)
    expect(w.text()).toContain('wordpress')
  })

  it('shows version disclosure warning when versionDisclosed is true', () => {
    const w = mountPanel(TECH_STACK_RESULT)
    expect(w.text()).toContain(en.siteHealth.pageInternals.versionDisclosed)
    expect(w.text()).toContain('WordPress 5.9.3')
  })
})
