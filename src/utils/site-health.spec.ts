/**
 * Unit tests for analyzeSiteHealth().
 *
 * Uses DOMParser (available in happy-dom) to construct document fixtures —
 * no network, no chrome API, no storage.
 */
import { describe, it, expect } from 'vitest'
import { analyzeSiteHealth } from './site-health'
import { GOV_TLDS, isGovHost } from './gov-host'

// happy-dom exposes DOMParser globally; map it to a convenient helper
function parseHtml(html: string, url = 'https://example.com/'): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // DOMParser doesn't set location; patch it so analyzeSiteHealth can read protocol/origin
  Object.defineProperty(doc, 'location', {
    value: new URL(url),
    writable: false,
    configurable: true,
  })
  return doc
}

// Story 1.12 — analyzeSiteHealth now takes the gov-TLD list as injected DATA (first
// arg). Every call threads the single source `GOV_TLDS`, matching the executeScript
// injection in SiteProfileView.vue.
const analyze = (doc: Document = document) => analyzeSiteHealth([...GOV_TLDS], doc)

// ── FIXTURES ─────────────────────────────────────────────────────────────────

const CLEAN_SITE = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Clean Site Title That Is Long Enough</title>
  <meta name="description" content="A clean test page.">
  <link rel="canonical" href="https://example.com/">
  <link rel="icon" href="/favicon.ico">
  <meta property="og:title" content="Clean Site">
  <meta property="og:description" content="Test">
  <meta property="og:image" content="https://example.com/og.png">
</head>
<body>
  <header><nav aria-label="Main navigation"><a href="/about">About</a></nav></header>
  <main>
    <h1>Welcome</h1>
    <h2>Section</h2>
    <img src="/hero.png" alt="Hero image">
    <form action="/submit">
      <label for="name">Name</label>
      <input id="name" type="text">
    </form>
    <a href="https://external.com" target="_blank" rel="noopener noreferrer">External</a>
  </main>
  <footer></footer>
</body>
</html>
`

const UNSAFE_SITE = `
<!DOCTYPE html>
<html>
<head>
  <title>Unsafe</title>
</head>
<body>
  <img src="http://cdn.evil.com/img.png">
  <img src="/local.png">
  <img src="/another.png">
  <form action="http://evil.com/submit">
    <input type="password" id="pw">
    <input type="text" id="user" aria-label="Username">
  </form>
  <a href="https://other.com/page" target="_blank">No rel</a>
  <a href="https://other.com/page2" target="_blank" rel="noopener">Has noopener</a>
  <a href="http://insecure.com">Insecure link</a>
  <h1>Title</h1>
  <h3>Skipped level</h3>
</body>
</html>
`

const HTTP_PASSWORD_SITE = `
<!DOCTYPE html>
<html lang="es">
<head><title>Login</title></head>
<body>
  <form>
    <label for="pass">Password</label>
    <input id="pass" type="password">
  </form>
</body>
</html>
`

// ── TESTS ─────────────────────────────────────────────────────────────────────

describe('analyzeSiteHealth', () => {
  describe('clean HTTPS site', () => {
    it('reports isHttps true', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.isHttps).toBe(true)
    })

    it('reports zero mixed content', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.mixedContentCount).toBe(0)
    })

    it('reports zero unsafe forms', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.unsafeFormCount).toBe(0)
    })

    it('reports passwordOnHttp false', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.passwordOnHttp).toBe(false)
    })

    it('reports zero blank-no-opener links', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.blankNoOpenerCount).toBe(0)
    })

    it('reports zero missing alt images', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.imgMissingAlt).toBe(0)
      expect(result.a11y.imgTotal).toBe(1)
    })

    it('reports zero inputs missing label', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.inputMissingLabel).toBe(0)
    })

    it('reports html lang present', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.missingHtmlLang).toBe(false)
    })

    it('reports h1Count = 1 and no skipped levels', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.h1Count).toBe(1)
      expect(result.a11y.headingLevelsSkipped).toBe(false)
    })

    it('detects ARIA landmarks', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.hasAriaLandmarks).toBe(true)
    })

    it('detects all meta signals', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.meta.hasTitle).toBe(true)
      expect(result.meta.titleLength).toBeGreaterThan(0)
      expect(result.meta.hasMetaDescription).toBe(true)
      expect(result.meta.hasCanonical).toBe(true)
      expect(result.meta.hasFavicon).toBe(true)
      expect(result.meta.hasOpenGraph).toBe(true)
    })

    it('counts links correctly', () => {
      const result = analyze(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.links.totalLinks).toBeGreaterThan(0)
      expect(result.links.insecureLinks).toBe(0)
    })
  })

  describe('unsafe HTTP site with mixed content, bad forms, missing alts', () => {
    it('reports isHttps false', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'http://unsafe.com/'))
      expect(result.security.isHttps).toBe(false)
    })

    it('does NOT count mixed content on http page (only relevant on https)', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'http://unsafe.com/'))
      expect(result.security.mixedContentCount).toBe(0)
    })

    it('counts mixed content on an https page', () => {
      // Same HTML served over https — now the http:// img is mixed content
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.security.mixedContentCount).toBe(1)
    })

    it('counts unsafe form (http action)', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.security.unsafeFormCount).toBe(1)
    })

    it('counts blank-no-opener links (only external ones without noopener)', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      // "No rel" link: no noopener → counted
      // "Has noopener" link: has noopener → not counted
      expect(result.security.blankNoOpenerCount).toBe(1)
    })

    it('counts insecure http:// link', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.links.insecureLinks).toBe(1)
    })

    it('reports heading levels skipped (h1 → h3)', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.headingLevelsSkipped).toBe(true)
    })

    it('reports missing html lang', () => {
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.missingHtmlLang).toBe(true)
    })

    it('reports images missing alt (only those without alt attribute)', () => {
      // UNSAFE_SITE has 3 img elements: all without alt attribute
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.imgMissingAlt).toBe(3)
      expect(result.a11y.imgTotal).toBe(3)
    })

    it('reports input missing label (password input has no label by id in that form)', () => {
      // password input id="pw" has a label with for="pass" — mismatch, no label for "pw"
      const result = analyze(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.inputMissingLabel).toBeGreaterThan(0)
    })
  })

  describe('HTTP page with password input', () => {
    it('reports passwordOnHttp true', () => {
      const result = analyze(parseHtml(HTTP_PASSWORD_SITE, 'http://login.example.com/'))
      expect(result.security.passwordOnHttp).toBe(true)
    })

    it('reports passwordOnHttp false on https even with password field', () => {
      const result = analyze(parseHtml(HTTP_PASSWORD_SITE, 'https://login.example.com/'))
      expect(result.security.passwordOnHttp).toBe(false)
    })
  })

  describe('missing meta signals', () => {
    const BARE = `<!DOCTYPE html><html lang="en"><head></head><body><h1>Hi</h1></body></html>`

    it('reports all meta missing', () => {
      const result = analyze(parseHtml(BARE))
      expect(result.meta.hasTitle).toBe(false)
      expect(result.meta.hasMetaDescription).toBe(false)
      expect(result.meta.hasCanonical).toBe(false)
      expect(result.meta.hasFavicon).toBe(false)
      expect(result.meta.hasOpenGraph).toBe(false)
    })

    it('title length is 0 when no title present', () => {
      const result = analyze(parseHtml(BARE))
      expect(result.meta.titleLength).toBe(0)
    })
  })

  describe('link counting', () => {
    const LINKS_HTML = `
      <!DOCTYPE html><html lang="en"><head><title>T</title></head><body>
        <a href="/internal">Internal relative</a>
        <a href="https://example.com/page">Internal absolute</a>
        <a href="https://other.com/page">External https</a>
        <a href="http://insecure.com/page">External http</a>
        <a href="#fragment">Fragment (ignored)</a>
        <a href="javascript:void(0)">JS (ignored)</a>
      </body></html>
    `

    it('counts total links excluding fragments and js:', () => {
      const result = analyze(parseHtml(LINKS_HTML, 'https://example.com/'))
      expect(result.links.totalLinks).toBe(4)
    })

    it('counts internal vs external links correctly', () => {
      const result = analyze(parseHtml(LINKS_HTML, 'https://example.com/'))
      // /internal (relative → internal) + https://example.com/page (same origin)
      expect(result.links.internalLinks).toBe(2)
      // https://other.com + http://insecure.com
      expect(result.links.externalLinks).toBe(2)
    })

    it('counts insecure http:// links', () => {
      const result = analyze(parseHtml(LINKS_HTML, 'https://example.com/'))
      expect(result.links.insecureLinks).toBe(1)
    })
  })
})

// ── NEW FIXTURES ──────────────────────────────────────────────────────────────

const COMMENTS_SECRET_SITE = `
<!DOCTYPE html>
<html lang="en">
<head><title>Comments Test</title></head>
<body>
  <!-- Normal comment: just a note -->
  <!-- https://internal.staging.example.com/admin -->
  <!-- TODO: fix password=abc123 -->
  <!-- abc123def456abc123def456abc123de -->
  <p>Content here</p>
</body>
</html>
`

const GOV_NONGOV_SCRIPT_SITE = `
<!DOCTYPE html>
<html lang="es">
<head><title>BCCR - Hacienda</title></head>
<body>
  <script src="https://cdn.googletagmanager.com/gtm.js"></script>
  <script src="/app.js"></script>
  <p>Content</p>
</body>
</html>
`

const WORDPRESS_SITE = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="generator" content="WordPress 5.9.3">
  <link rel="stylesheet" href="/wp-content/themes/mytheme/style.css">
  <title>WP Site</title>
</head>
<body><p>Hello</p></body>
</html>
`

const ASPNET_SITE = `
<!DOCTYPE html>
<html lang="en">
<head><title>ASP.NET Site</title></head>
<body>
  <form action="/Page.aspx" method="post">
    <input type="hidden" name="__VIEWSTATE" value="abc123">
    <input type="submit" value="Submit">
  </form>
</body>
</html>
`

// ── NEW TESTS ─────────────────────────────────────────────────────────────────

describe('comments check', () => {
  it('detects comment nodes and flags suspicious ones', () => {
    const result = analyze(parseHtml(COMMENTS_SECRET_SITE, 'https://example.com/'))
    expect(result.comments.total).toBeGreaterThan(0)
    expect(result.comments.flaggedCount).toBeGreaterThanOrEqual(2)
    expect(result.comments.samples.length).toBeLessThanOrEqual(3)
  })
})

describe('scripts and supply chain check', () => {
  it('flags govHostWithNonGovScripts on gov host with external non-gov script', () => {
    const result = analyze(parseHtml(GOV_NONGOV_SCRIPT_SITE, 'https://hacienda.go.cr/'))
    expect(result.scripts.govHostWithNonGovScripts).toBe(true)
    expect(result.scripts.externalThirdPartyNonGov).toBeGreaterThanOrEqual(1)
  })
})

describe('tech stack detection', () => {
  it('detects WordPress and reports version disclosed', () => {
    const result = analyze(parseHtml(WORDPRESS_SITE, 'https://example.com/'))
    expect(result.techStack.detectedPlatforms).toContain('wordpress')
    expect(result.techStack.versionDisclosed).toBe(true)
    expect(result.techStack.generatorMetaValue).toContain('WordPress')
  })

  it('detects ASP.NET from VIEWSTATE and .aspx action', () => {
    const result = analyze(parseHtml(ASPNET_SITE, 'https://example.com/'))
    expect(result.techStack.detectedPlatforms).toContain('aspnet')
  })
})

describe('gov-host classification — single home, injected as data (Story 1.12)', () => {
  // A page (non-gov origin) with one external link to https://<host>/.
  const pageWithExternalLink = (host: string) =>
    parseHtml(`<html><body><a href="https://${host}/x">L</a></body></html>`, 'https://example.com/')

  it('ANTI-INLINE — classification is driven by the INJECTED list, not a re-inlined copy', () => {
    // real list → the .go.cr link is classified gov
    expect(analyzeSiteHealth([...GOV_TLDS], pageWithExternalLink('hacienda.go.cr')).thirdPartyLinks.govCount).toBe(1)
    // empty list → NOTHING is gov. A re-inlined GOV_TLDS would keep counting → this reddens.
    expect(analyzeSiteHealth([], pageWithExternalLink('hacienda.go.cr')).thirdPartyLinks.govCount).toBe(0)
  })

  it.each([
    'go.cr', // bare SLD — the FIXED divergence (was gov via `===`, now non-gov like isGovHost)
    'hacienda.go.cr',
    'www.hacienda.go.cr',
    'x.fi.cr',
    'example.com',
    'notgov.com',
  ])('PARITY — external link to %s classified === isGovHost (the source oracle)', (host) => {
    const govCount = analyzeSiteHealth([...GOV_TLDS], pageWithExternalLink(host)).thirdPartyLinks.govCount
    expect(govCount).toBe(isGovHost(host) ? 1 : 0)
  })

  it('PARITY (page host) — a bare-SLD go.cr page is NOT gov (matches isGovHost; `===` clause gone)', () => {
    const doc = parseHtml(`<html><body><img src="https://cdn.example.net/a.png"></body></html>`, 'https://go.cr/')
    expect(analyzeSiteHealth([...GOV_TLDS], doc).thirdPartyLinks.govHostWithNonGovResources).toBe(isGovHost('go.cr'))
    expect(isGovHost('go.cr')).toBe(false) // pin the oracle
  })

  it('SERIALIZABLE — rehydrated via new Function (no closure capture) yields the same classification', () => {
    const rehydrated = new Function('return (' + analyzeSiteHealth.toString() + ')')() as typeof analyzeSiteHealth
    expect(rehydrated([...GOV_TLDS], pageWithExternalLink('hacienda.go.cr')).thirdPartyLinks.govCount).toBe(1)
  })
})
