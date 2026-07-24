/**
 * Unit tests for analyzeSiteHealth().
 *
 * Uses DOMParser (available in happy-dom) to construct document fixtures —
 * no network, no chrome API, no storage.
 */
import { describe, it, expect } from 'vitest'
import { analyzeSiteHealth } from './site-health'

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
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.isHttps).toBe(true)
    })

    it('reports zero mixed content', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.mixedContentCount).toBe(0)
    })

    it('reports zero unsafe forms', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.unsafeFormCount).toBe(0)
    })

    it('reports passwordOnHttp false', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.passwordOnHttp).toBe(false)
    })

    it('reports zero blank-no-opener links', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.security.blankNoOpenerCount).toBe(0)
    })

    it('reports zero missing alt images', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.imgMissingAlt).toBe(0)
      expect(result.a11y.imgTotal).toBe(1)
    })

    it('reports zero inputs missing label', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.inputMissingLabel).toBe(0)
    })

    it('reports html lang present', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.missingHtmlLang).toBe(false)
    })

    it('reports h1Count = 1 and no skipped levels', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.h1Count).toBe(1)
      expect(result.a11y.headingLevelsSkipped).toBe(false)
    })

    it('detects ARIA landmarks', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.a11y.hasAriaLandmarks).toBe(true)
    })

    it('detects all meta signals', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.meta.hasTitle).toBe(true)
      expect(result.meta.titleLength).toBeGreaterThan(0)
      expect(result.meta.hasMetaDescription).toBe(true)
      expect(result.meta.hasCanonical).toBe(true)
      expect(result.meta.hasFavicon).toBe(true)
      expect(result.meta.hasOpenGraph).toBe(true)
    })

    it('counts links correctly', () => {
      const result = analyzeSiteHealth(parseHtml(CLEAN_SITE, 'https://example.com/'))
      expect(result.links.totalLinks).toBeGreaterThan(0)
      expect(result.links.insecureLinks).toBe(0)
    })
  })

  describe('unsafe HTTP site with mixed content, bad forms, missing alts', () => {
    it('reports isHttps false', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'http://unsafe.com/'))
      expect(result.security.isHttps).toBe(false)
    })

    it('does NOT count mixed content on http page (only relevant on https)', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'http://unsafe.com/'))
      expect(result.security.mixedContentCount).toBe(0)
    })

    it('counts mixed content on an https page', () => {
      // Same HTML served over https — now the http:// img is mixed content
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.security.mixedContentCount).toBe(1)
    })

    it('counts unsafe form (http action)', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.security.unsafeFormCount).toBe(1)
    })

    it('counts blank-no-opener links (only external ones without noopener)', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      // "No rel" link: no noopener → counted
      // "Has noopener" link: has noopener → not counted
      expect(result.security.blankNoOpenerCount).toBe(1)
    })

    it('counts insecure http:// link', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.links.insecureLinks).toBe(1)
    })

    it('reports heading levels skipped (h1 → h3)', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.headingLevelsSkipped).toBe(true)
    })

    it('reports missing html lang', () => {
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.missingHtmlLang).toBe(true)
    })

    it('reports images missing alt (only those without alt attribute)', () => {
      // UNSAFE_SITE has 3 img elements: all without alt attribute
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.imgMissingAlt).toBe(3)
      expect(result.a11y.imgTotal).toBe(3)
    })

    it('reports input missing label (password input has no label by id in that form)', () => {
      // password input id="pw" has a label with for="pass" — mismatch, no label for "pw"
      const result = analyzeSiteHealth(parseHtml(UNSAFE_SITE, 'https://unsafe.com/'))
      expect(result.a11y.inputMissingLabel).toBeGreaterThan(0)
    })
  })

  describe('HTTP page with password input', () => {
    it('reports passwordOnHttp true', () => {
      const result = analyzeSiteHealth(parseHtml(HTTP_PASSWORD_SITE, 'http://login.example.com/'))
      expect(result.security.passwordOnHttp).toBe(true)
    })

    it('reports passwordOnHttp false on https even with password field', () => {
      const result = analyzeSiteHealth(parseHtml(HTTP_PASSWORD_SITE, 'https://login.example.com/'))
      expect(result.security.passwordOnHttp).toBe(false)
    })
  })

  describe('missing meta signals', () => {
    const BARE = `<!DOCTYPE html><html lang="en"><head></head><body><h1>Hi</h1></body></html>`

    it('reports all meta missing', () => {
      const result = analyzeSiteHealth(parseHtml(BARE))
      expect(result.meta.hasTitle).toBe(false)
      expect(result.meta.hasMetaDescription).toBe(false)
      expect(result.meta.hasCanonical).toBe(false)
      expect(result.meta.hasFavicon).toBe(false)
      expect(result.meta.hasOpenGraph).toBe(false)
    })

    it('title length is 0 when no title present', () => {
      const result = analyzeSiteHealth(parseHtml(BARE))
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
      const result = analyzeSiteHealth(parseHtml(LINKS_HTML, 'https://example.com/'))
      expect(result.links.totalLinks).toBe(4)
    })

    it('counts internal vs external links correctly', () => {
      const result = analyzeSiteHealth(parseHtml(LINKS_HTML, 'https://example.com/'))
      // /internal (relative → internal) + https://example.com/page (same origin)
      expect(result.links.internalLinks).toBe(2)
      // https://other.com + http://insecure.com
      expect(result.links.externalLinks).toBe(2)
    })

    it('counts insecure http:// links', () => {
      const result = analyzeSiteHealth(parseHtml(LINKS_HTML, 'https://example.com/'))
      expect(result.links.insecureLinks).toBe(1)
    })
  })
})
