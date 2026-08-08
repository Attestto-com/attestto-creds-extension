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

export interface SiteHealthComments {
  total: number                 // total HTML comment nodes
  flaggedCount: number          // comments with URLs, staging hosts, or secret-looking tokens
  samples: string[]             // up to 3 truncated samples (max 80 chars each)
}

export interface SiteHealthThirdPartyLinks {
  internalCount: number
  externalCount: number
  govCount: number              // links to .go.cr/.fi.cr/.sa.cr/.ac.cr/.ed.cr/.or.cr
  nonGovExternalCount: number
  thirdPartyResourceCount: number  // img/script/link/iframe src pointing to non-same-origin hosts
  govHostWithNonGovResources: boolean  // true when pageHost is .go.cr etc AND nonGovExternal > 0
}

export interface SiteHealthScripts {
  externalFirstParty: number    // <script src> same origin
  externalThirdParty: number    // <script src> different origin
  externalThirdPartyNonGov: number  // different origin AND not a gov TLD
  inlineCount: number
  govHostWithNonGovScripts: boolean  // flag when gov host + nonGov third-party scripts > 0
  // NOTE: scripts injected after page load require a persistent content-script MutationObserver
  // and cannot be detected in this snapshot-based analysis. See: TODO(dynamic-scripts)
}

export type TechStackPlatform = 'wordpress' | 'aspnet' | 'php' | 'drupal' | 'joomla' | 'wix' | 'squarespace'
export type TechStackFramework = 'react' | 'vue' | 'angular' | 'jquery' | null

export interface SiteHealthTechStack {
  detectedPlatforms: TechStackPlatform[]
  jsFramework: TechStackFramework
  versionDisclosed: boolean     // true if generator meta leaks a version string
  outdatedHint: boolean         // true when a well-known outdated version pattern is detected
  generatorMetaValue: string | null  // e.g. "WordPress 5.9.3" — from <meta name="generator">
  // NOTE: HTTP response headers (Server, X-Powered-By) are not accessible from content scripts.
  // TODO(tech-stack-headers): use chrome.webRequest API (requires webRequest permission) for header-based detection.
}

export interface SiteHealthResult {
  security: SiteHealthSecurity
  a11y: SiteHealthA11y
  meta: SiteHealthMeta
  links: SiteHealthLinks
  comments: SiteHealthComments         // NEW
  thirdPartyLinks: SiteHealthThirdPartyLinks  // NEW
  scripts: SiteHealthScripts           // NEW
  techStack: SiteHealthTechStack       // NEW
}

/**
 * Analyze the given document and return site health stats.
 *
 * Designed to be serializable: no module imports, no closures. Pass it directly
 * as `func: analyzeSiteHealth` (no args) to chrome.scripting.executeScript — the
 * `doc` param defaults to the injected page's `document` (args like `document`
 * cannot be serialized across the executeScript boundary). Tests pass an explicit
 * document.
 */
export function analyzeSiteHealth(doc: Document = document): SiteHealthResult {
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

  // ── Comments ───────────────────────────────────────────────────────────────

  const GOV_TLDS_INLINE = ['.go.cr', '.fi.cr', '.sa.cr', '.ac.cr', '.ed.cr', '.or.cr']

  // Walk the document tree for comment nodes
  const commentWalker = typeof doc.createNodeIterator === 'function'
    ? doc.createNodeIterator(doc, 128 /* NodeFilter.SHOW_COMMENT */)
    : null

  let commentsTotal = 0
  let commentsFlagged = 0
  const commentSamples: string[] = []

  if (commentWalker) {
    let node: Node | null
    while ((node = commentWalker.nextNode()) !== null) {
      const text = (node as Comment).data || ''
      commentsTotal++
      // Flag if contains URL, staging keyword, or secret-looking token
      const hasUrl = /https?:\/\//i.test(text)
      const hasStagingKeyword = /\b(staging|internal|dev\.|localhost|127\.0\.|10\.|192\.168\.)/i.test(text)
      const hasLongHex = /[0-9a-f]{16,}/i.test(text)
      const hasLongBase64 = /[A-Za-z0-9+/]{32,}={0,2}/.test(text)
      // stub-guard-ignore: these are detection patterns for scanning comments, not code stubs
      const hasSecretKeyword = /password|api_key|apikey|secret|token\b|TODO|FIXME/i.test(text)
      const isFlagged = hasUrl || hasStagingKeyword || hasLongHex || hasLongBase64 || hasSecretKeyword
      if (isFlagged) {
        commentsFlagged++
        if (commentSamples.length < 3) {
          // Redact if it looks like an actual secret value
          if (hasLongHex || hasLongBase64) {
            commentSamples.push('[comment contains potential secret — value redacted]')
          } else {
            commentSamples.push(text.trim().slice(0, 80))
          }
        }
      }
    }
  }

  // ── Third-party links ──────────────────────────────────────────────────────

  const pageHost = (() => {
    try { return new URL(pageOrigin).hostname } catch { return '' }
  })()

  const isGovTld = (host: string): boolean =>
    GOV_TLDS_INLINE.some((tld) => host === tld.slice(1) || host.endsWith(tld))

  const pageIsGov = isGovTld(pageHost)

  let tplInternalCount = 0
  let tplExternalCount = 0
  let tplGovCount = 0
  let tplNonGovExternalCount = 0
  const thirdPartyResourceHosts = new Set<string>()

  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return
    if (/^https?:\/\//i.test(href)) {
      try {
        const linkUrl = new URL(href)
        const linkHost = linkUrl.hostname
        if (pageOrigin && linkUrl.origin === pageOrigin) {
          tplInternalCount++
        } else {
          tplExternalCount++
          if (isGovTld(linkHost)) {
            tplGovCount++
          } else {
            tplNonGovExternalCount++
          }
        }
      } catch { /* malformed URL */ }
    } else {
      tplInternalCount++
    }
  })

  // Third-party resources: img/script/link/iframe pointing to non-same-origin
  const resourceEls = [
    ...Array.from(doc.querySelectorAll('img[src]')).map((el) => el.getAttribute('src') ?? ''),
    ...Array.from(doc.querySelectorAll('script[src]')).map((el) => el.getAttribute('src') ?? ''),
    ...Array.from(doc.querySelectorAll('link[href]')).map((el) => el.getAttribute('href') ?? ''),
    ...Array.from(doc.querySelectorAll('iframe[src]')).map((el) => el.getAttribute('src') ?? ''),
  ]
  for (const url of resourceEls) {
    if (!url || !/^https?:\/\//i.test(url)) continue
    try {
      const resUrl = new URL(url)
      if (pageOrigin && resUrl.origin !== pageOrigin) {
        thirdPartyResourceHosts.add(resUrl.hostname)
      }
    } catch { /* skip */ }
  }

  const thirdPartyResourceCount = thirdPartyResourceHosts.size
  const govHostWithNonGovResources =
    pageIsGov && Array.from(thirdPartyResourceHosts).some((h) => !isGovTld(h))

  // ── Scripts ────────────────────────────────────────────────────────────────

  let scriptsExternalFirstParty = 0
  let scriptsExternalThirdParty = 0
  let scriptsExternalThirdPartyNonGov = 0

  doc.querySelectorAll('script[src]').forEach((el) => {
    const src = el.getAttribute('src') ?? ''
    if (!src) return
    if (!/^https?:\/\//i.test(src)) {
      // Relative URL → first party
      scriptsExternalFirstParty++
      return
    }
    try {
      const scriptUrl = new URL(src)
      if (pageOrigin && scriptUrl.origin === pageOrigin) {
        scriptsExternalFirstParty++
      } else {
        scriptsExternalThirdParty++
        if (!isGovTld(scriptUrl.hostname)) {
          scriptsExternalThirdPartyNonGov++
        }
      }
    } catch { /* skip */ }
  })

  const scriptsInlineCount = doc.querySelectorAll('script:not([src])').length
  const govHostWithNonGovScripts = pageIsGov && scriptsExternalThirdPartyNonGov > 0

  // ── Tech stack ────────────────────────────────────────────────────────────

  const generatorMeta = doc.querySelector('meta[name="generator"]')
  const generatorMetaValue = generatorMeta?.getAttribute('content') ?? null
  const generatorLower = (generatorMetaValue ?? '').toLowerCase()

  const detectedPlatforms: TechStackPlatform[] = []

  // WordPress
  const hasWpContent = Array.from(doc.querySelectorAll('script[src], link[href]')).some((el) => {
    const val = (el.getAttribute('src') ?? el.getAttribute('href') ?? '')
    return /wp-content|wp-json/.test(val)
  })
  if (hasWpContent || generatorLower.includes('wordpress')) {
    detectedPlatforms.push('wordpress')
  }

  // ASP.NET
  const hasViewState = doc.querySelector('input[name="__VIEWSTATE"]') !== null
  const hasAspxHref = Array.from(doc.querySelectorAll('a[href], form[action]')).some((el) => {
    const val = el.getAttribute('href') ?? el.getAttribute('action') ?? ''
    return /\.aspx/i.test(val)
  })
  if (hasViewState || hasAspxHref || generatorLower.includes('asp.net')) {
    detectedPlatforms.push('aspnet')
  }

  // PHP
  const hasPhpHref = Array.from(doc.querySelectorAll('a[href], form[action]')).some((el) => {
    const val = el.getAttribute('href') ?? el.getAttribute('action') ?? ''
    return /\.php/i.test(val)
  })
  if (hasPhpHref || generatorLower.includes('php')) {
    detectedPlatforms.push('php')
  }

  // Drupal
  if (generatorLower.includes('drupal')) {
    detectedPlatforms.push('drupal')
  }

  // Joomla
  if (generatorLower.includes('joomla')) {
    detectedPlatforms.push('joomla')
  }

  // Wix
  const hasWixScript = Array.from(doc.querySelectorAll('script[src]')).some((el) => {
    const src = el.getAttribute('src') ?? ''
    return /wix\.com|wixstatic/.test(src)
  })
  if (hasWixScript) {
    detectedPlatforms.push('wix')
  }

  // Squarespace
  const hasSquarespaceScript = Array.from(doc.querySelectorAll('script[src]')).some((el) => {
    const src = el.getAttribute('src') ?? ''
    return /squarespace/.test(src)
  })
  if (hasSquarespaceScript) {
    detectedPlatforms.push('squarespace')
  }

  // JS Framework detection
  let jsFramework: TechStackFramework = null
  // React: data-reactroot attr or meta name="next-head-count"
  if (
    doc.querySelector('[data-reactroot]') !== null ||
    doc.querySelector('meta[name="next-head-count"]') !== null
  ) {
    jsFramework = 'react'
  }
  // Vue: data-v-* attributes or __vue_app__
  else if (doc.querySelector('[data-v-app]') !== null || doc.querySelector('[__vue_app__]') !== null) {
    jsFramework = 'vue'
  }
  // Angular: ng-version or data-ng-* attributes
  else if (
    doc.querySelector('[ng-version]') !== null ||
    doc.querySelector('[data-ng-app]') !== null
  ) {
    jsFramework = 'angular'
  }
  // jQuery: script src containing jquery
  else if (
    Array.from(doc.querySelectorAll('script[src]')).some((el) =>
      /jquery/i.test(el.getAttribute('src') ?? ''),
    )
  ) {
    jsFramework = 'jquery'
  }

  // Version disclosed: generator meta contains a version number pattern
  const versionDisclosed = generatorMetaValue !== null && /\d+\.\d+/.test(generatorMetaValue)

  // outdatedHint: TODO — can't know latest versions without network // stub-guard-ignore
  const outdatedHint = false

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
    comments: {
      total: commentsTotal,
      flaggedCount: commentsFlagged,
      samples: commentSamples,
    },
    thirdPartyLinks: {
      internalCount: tplInternalCount,
      externalCount: tplExternalCount,
      govCount: tplGovCount,
      nonGovExternalCount: tplNonGovExternalCount,
      thirdPartyResourceCount,
      govHostWithNonGovResources,
    },
    scripts: {
      externalFirstParty: scriptsExternalFirstParty,
      externalThirdParty: scriptsExternalThirdParty,
      externalThirdPartyNonGov: scriptsExternalThirdPartyNonGov,
      inlineCount: scriptsInlineCount,
      govHostWithNonGovScripts,
    },
    techStack: {
      detectedPlatforms,
      jsFramework,
      versionDisclosed,
      outdatedHint,
      generatorMetaValue,
    },
  }
}
