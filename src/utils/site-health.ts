/**
 * Site health analyzer — DOM-only, no network, no storage.
 *
 * `analyzeSiteHealth()` is a pure function over a `Document` object (or any
 * object with the same surface — DOMParser produces compatible results).
 * It is safe to serialize and inject via chrome.scripting.executeScript
 * because it has no closure captures.
 *
 * Returns structured stats grouped into four concern areas:
 *   security  — HTTPS hygiene, mixed content, unsafe forms, blank links
 *   a11y      — images, labels, lang, headings, ARIA landmarks
 *   meta      — title, description, canonical, favicon, Open Graph
 *   links     — totals, internal vs external, insecure counts
 *
 * Nothing is sent off-device. Nothing is written to storage.
 */

export interface SiteHealthSecurity {
  /** Page was loaded over HTTPS */
  isHttps: boolean
  /** Count of http:// resource refs (img/script/link/iframe src/href) on an https page */
  mixedContentCount: number
  /** Forms with an http:// action OR an action on a different origin */
  unsafeFormCount: number
  /** At least one password/credential input exists on a non-HTTPS page */
  passwordOnHttp: boolean
  /** External links with target=_blank missing rel="noopener" or rel="noreferrer" */
  blankNoOpenerCount: number
}

export interface SiteHealthA11y {
  /** Number of <img> elements missing a non-empty alt attribute */
  imgMissingAlt: number
  /** Total <img> elements */
  imgTotal: number
  /** Form inputs (input, select, textarea) missing a label or aria-label */
  inputMissingLabel: number
  /** <html> element is missing a lang attribute */
  missingHtmlLang: boolean
  /** Number of <h1> elements */
  h1Count: number
  /** Heading levels are skipped (e.g. h1 → h3 with no h2) */
  headingLevelsSkipped: boolean
  /** At least one element has a landmark or ARIA role */
  hasAriaLandmarks: boolean
}

export interface SiteHealthMeta {
  /** <title> element is present */
  hasTitle: boolean
  /** Length of <title> text content (0 if absent) */
  titleLength: number
  /** <meta name="description"> is present */
  hasMetaDescription: boolean
  /** <link rel="canonical"> is present */
  hasCanonical: boolean
  /** Favicon detected (<link rel="icon|shortcut icon"> or /favicon.ico) */
  hasFavicon: boolean
  /** Basic Open Graph tags present (og:title, og:description, og:image) */
  hasOpenGraph: boolean
}

export interface SiteHealthLinks {
  /** Total anchor elements */
  totalLinks: number
  /** Links to the same origin */
  internalLinks: number
  /** Links to external origins */
  externalLinks: number
  /** Links using http:// (not https://) */
  insecureLinks: number
}

export interface SiteHealthResult {
  security: SiteHealthSecurity
  a11y: SiteHealthA11y
  meta: SiteHealthMeta
  links: SiteHealthLinks
}

/**
 * Analyze the given document and return site health stats.
 *
 * Designed to be serializable: no module imports, no closures.
 * Can be passed directly to chrome.scripting.executeScript as an inline function
 * using `func: () => analyzeSiteHealth(document)`.
 */
export function analyzeSiteHealth(doc: Document): SiteHealthResult {
  const pageOrigin = doc.location?.origin ?? ''
  const pageProtocol = doc.location?.protocol ?? ''

  // ── Security ───────────────────────────────────────────────────────────────

  const isHttps = pageProtocol === 'https:'

  // Mixed content: http:// resource refs on an https page
  let mixedContentCount = 0
  if (isHttps) {
    const resourceSelectors = [
      { sel: 'img[src]', attr: 'src' },
      { sel: 'script[src]', attr: 'src' },
      { sel: 'link[href]', attr: 'href' },
      { sel: 'iframe[src]', attr: 'src' },
    ]
    for (const { sel, attr } of resourceSelectors) {
      doc.querySelectorAll(sel).forEach((el) => {
        const val = el.getAttribute(attr) ?? ''
        if (/^http:\/\//i.test(val)) mixedContentCount++
      })
    }
  }

  // Unsafe forms: http:// action OR cross-origin action
  let unsafeFormCount = 0
  doc.querySelectorAll('form[action]').forEach((form) => {
    const action = form.getAttribute('action') ?? ''
    if (!action || action.startsWith('#') || action.startsWith('javascript:')) return
    const isAbsoluteHttp = /^http:\/\//i.test(action)
    let isCrossOrigin = false
    if (pageOrigin && /^https?:\/\//i.test(action)) {
      try {
        const actionOrigin = new URL(action).origin
        isCrossOrigin = actionOrigin !== pageOrigin
      } catch {
        // malformed URL — treat conservatively
        isCrossOrigin = true
      }
    }
    if (isAbsoluteHttp || isCrossOrigin) unsafeFormCount++
  })

  // Password/credential input on non-HTTPS page
  const passwordInputs = doc.querySelectorAll(
    'input[type="password"], input[autocomplete*="current-password"], input[autocomplete*="new-password"]',
  )
  const passwordOnHttp = !isHttps && passwordInputs.length > 0

  // External links with target=_blank missing rel=noopener
  let blankNoOpenerCount = 0
  doc.querySelectorAll('a[target="_blank"]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    // Only count external links (skip fragments, relative paths, same-origin)
    if (!href || href.startsWith('#')) return
    const isExternal = /^https?:\/\//i.test(href) && pageOrigin
      ? (() => {
          try {
            return new URL(href).origin !== pageOrigin
          } catch {
            return false
          }
        })()
      : /^https?:\/\//i.test(href)
    if (!isExternal) return
    const rel = a.getAttribute('rel') ?? ''
    const rels = rel.toLowerCase().split(/\s+/)
    if (!rels.includes('noopener') && !rels.includes('noreferrer')) blankNoOpenerCount++
  })

  // ── Accessibility ──────────────────────────────────────────────────────────

  const allImgs = doc.querySelectorAll('img')
  let imgMissingAlt = 0
  allImgs.forEach((img) => {
    // alt="" (empty string) is valid for decorative images; absence is the problem
    if (!img.hasAttribute('alt')) imgMissingAlt++
  })

  // Inputs missing a label or aria-label
  let inputMissingLabel = 0
  doc
    .querySelectorAll<HTMLElement>('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea')
    .forEach((input) => {
      const id = input.getAttribute('id')
      const ariaLabel = input.getAttribute('aria-label')
      const ariaLabelledBy = input.getAttribute('aria-labelledby')
      const title = input.getAttribute('title')
      const hasLabel = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) !== null : false
      // Also check if the input is wrapped inside a <label>
      const wrappedInLabel = input.closest('label') !== null
      if (!hasLabel && !wrappedInLabel && !ariaLabel && !ariaLabelledBy && !title) {
        inputMissingLabel++
      }
    })

  const htmlEl = doc.documentElement
  const missingHtmlLang = !htmlEl?.getAttribute('lang')?.trim()

  // Heading level analysis
  const headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6')
  const h1Count = doc.querySelectorAll('h1').length
  const presentLevels = new Set<number>()
  headings.forEach((h) => {
    const level = parseInt(h.tagName[1], 10)
    presentLevels.add(level)
  })
  let headingLevelsSkipped = false
  if (presentLevels.size > 0) {
    const sorted = Array.from(presentLevels).sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) {
        headingLevelsSkipped = true
        break
      }
    }
  }

  // ARIA landmarks: elements with role attribute OR semantic landmark elements
  const landmarkRoles = ['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region']
  const semanticLandmarks = ['main', 'nav', 'header', 'footer', 'aside', 'section']
  const hasAriaLandmarks =
    landmarkRoles.some((role) => doc.querySelector(`[role="${role}"]`) !== null) ||
    semanticLandmarks.some((tag) => doc.querySelector(tag) !== null)

  // ── Meta ───────────────────────────────────────────────────────────────────

  const titleEl = doc.querySelector('title')
  const hasTitle = titleEl !== null
  const titleLength = titleEl?.textContent?.trim().length ?? 0

  const hasMetaDescription =
    doc.querySelector('meta[name="description"]') !== null ||
    doc.querySelector('meta[property="og:description"]') !== null

  const hasCanonical = doc.querySelector('link[rel="canonical"]') !== null

  const hasFavicon =
    doc.querySelector('link[rel="icon"]') !== null ||
    doc.querySelector('link[rel="shortcut icon"]') !== null ||
    doc.querySelector('link[rel="apple-touch-icon"]') !== null

  const hasOpenGraph =
    doc.querySelector('meta[property="og:title"]') !== null &&
    doc.querySelector('meta[property="og:description"]') !== null &&
    doc.querySelector('meta[property="og:image"]') !== null

  // ── Links ──────────────────────────────────────────────────────────────────

  const allAnchors = doc.querySelectorAll('a[href]')
  let totalLinks = 0
  let internalLinks = 0
  let externalLinks = 0
  let insecureLinks = 0

  allAnchors.forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return
    totalLinks++
    if (/^https?:\/\//i.test(href)) {
      if (/^http:\/\//i.test(href)) insecureLinks++
      const isInternal = pageOrigin
        ? (() => {
            try {
              return new URL(href).origin === pageOrigin
            } catch {
              return false
            }
          })()
        : false
      if (isInternal) {
        internalLinks++
      } else {
        externalLinks++
      }
    } else {
      // Relative links are internal
      internalLinks++
    }
  })

  return {
    security: {
      isHttps,
      mixedContentCount,
      unsafeFormCount,
      passwordOnHttp,
      blankNoOpenerCount,
    },
    a11y: {
      imgMissingAlt,
      imgTotal: allImgs.length,
      inputMissingLabel,
      missingHtmlLang,
      h1Count,
      headingLevelsSkipped,
      hasAriaLandmarks,
    },
    meta: {
      hasTitle,
      titleLength,
      hasMetaDescription,
      hasCanonical,
      hasFavicon,
      hasOpenGraph,
    },
    links: {
      totalLinks,
      internalLinks,
      externalLinks,
      insecureLinks,
    },
  }
}
