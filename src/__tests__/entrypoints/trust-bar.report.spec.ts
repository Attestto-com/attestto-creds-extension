/**
 * trust-bar.content.ts — the threat report's privacy contract.
 *
 * The file header states it as a rule:
 *
 *   "Posts ONLY the allowed fields (hostname, tld, findingType, severity,
 *    timestamp, extensionVersion) via the background SW — never path, page
 *    content, or PII."
 *
 * Nothing enforced it. The existing spec covers the two predicates
 * (`isInsecurePage`, `hasSensitiveForm`) and one negative injection case; the
 * report payload — the only thing in this feature that leaves the user's
 * machine — was untested at 13.5% coverage.
 *
 * A rule written only in a comment is a rule until someone adds `url` to help
 * with triage. It would be a reasonable-looking change: this bar fires on
 * government pages collecting personal data, so the reports carry exactly the
 * browsing the user would least want forwarded.
 *
 * ── Why the assertion is an EXACT key set ─────────────────────────────────
 *
 * Checking that `url` is absent only catches the field I thought of. Pinning
 * the whole key set catches every field nobody has invented yet, and forces a
 * deliberate edit here when the contract genuinely changes.
 *
 * The bar itself is warn-only — there is no "safe" state it could show — so
 * failing soft costs a warning and never manufactures assurance. That is the
 * right shape for a display path and it is not what these tests are about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const GOV_HOST = 'tramites.hacienda.go.cr'
/** Values a leak would carry. Neither may appear anywhere in a report. */
const SECRET_PATH = '/solicitud/paso-3?expediente=12345'
const SECRET_INPUT = 'cedula-1-2345-6789'

type Sent = { type: string; payload: Record<string, unknown> }

function setPage({ protocol = 'http:', host = GOV_HOST } = {}): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      protocol,
      hostname: host,
      host,
      origin: `${protocol}//${host}`,
      href: `${protocol}//${host}${SECRET_PATH}`,
      pathname: SECRET_PATH,
    },
  })
  // An insecure government form collecting personal data — the exact condition
  // the bar exists to warn about.
  document.body.innerHTML = `
    <form action="http://${host}/submit">
      <input type="text" name="cedula" value="${SECRET_INPUT}" />
      <input type="password" name="clave" value="hunter2" />
    </form>`
}

async function boot(
  opts: { settings?: Record<string, unknown>; dismissed?: string[] } = {},
): Promise<{ sent: Sent[] }> {
  const { settings = { trustBarEnabled: true }, dismissed = [] } = opts
  const sent: Sent[] = []

  vi.stubGlobal('defineContentScript', (def: { main: () => void }) => def)
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (msg: Sent) => {
        sent.push(msg)
        return { ok: true }
      },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
    // Two different areas on purpose: settings live in `storage.sync` (they
    // follow the user across profiles) and the dismissal list in
    // `storage.local` (it is per-machine). Stubbing both to one area made the
    // bar silently never mount — the first version of this file failed six
    // tests for that reason, not for any defect in the source.
    storage: {
      sync: { get: async () => ({ attestto_settings: settings }), set: async () => undefined },
      local: {
        get: async () => ({ attestto_trust_bar_dismissed: dismissed }),
        set: async () => undefined,
      },
      onChanged: { addListener: vi.fn() },
    },
  })

  const mod = (await import('@/entrypoints/trust-bar.content')) as unknown as {
    default: { main: () => void }
  }
  mod.default.main()
  // `main()` calls `void run()`, which awaits settings and dismissal before it
  // can mount anything. Let those microtasks drain.
  await new Promise((r) => setTimeout(r, 0))
  return { sent }
}

/** The bar lives in a shadow root so the page cannot restyle or hide it. */
function reportButton(): HTMLButtonElement | null {
  const hostEl = document.getElementById('attestto-trust-bar-host')
  const root = hostEl?.shadowRoot
  return (root?.querySelector('button.report') as HTMLButtonElement) ?? null
}

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = ''
  document.getElementById('attestto-trust-bar-host')?.remove()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the threat report carries only what the contract allows', () => {
  it('sends exactly the six documented fields, and nothing else', async () => {
    setPage()
    const { sent } = await boot()

    const btn = reportButton()
    expect(btn, 'no report button — the bar did not mount').not.toBeNull()
    btn!.click()
    await new Promise((r) => setTimeout(r, 0))

    const reports = sent.filter((m) => m.type === 'SUBMIT_THREAT_REPORT')
    expect(reports).toHaveLength(1)
    expect(Object.keys(reports[0].payload).sort()).toEqual([
      'extensionVersion',
      'findingType',
      'hostname',
      'severity',
      'timestamp',
      'tld',
    ])
  })

  it('no part of the report contains the page path or any form value', async () => {
    // The catch-all. Serialising the whole message means a leak smuggled into
    // a nested object or a differently-named field is caught too, not just the
    // top-level key I predicted.
    setPage()
    const { sent } = await boot()
    reportButton()!.click()
    await new Promise((r) => setTimeout(r, 0))

    const serialised = JSON.stringify(sent)
    expect(serialised).not.toContain(SECRET_PATH)
    expect(serialised).not.toContain('expediente')
    expect(serialised).not.toContain(SECRET_INPUT)
    expect(serialised).not.toContain('hunter2')
  })

  it('reports the hostname it warned about', async () => {
    // The counterweight to the two tests above: a report that stripped
    // everything would satisfy them and be useless. The hostname is the one
    // field the report exists to carry.
    setPage()
    const { sent } = await boot()
    reportButton()!.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent[0].payload.hostname).toBe(GOV_HOST)
  })

  it('nothing is sent until the user clicks', async () => {
    // "Explicit user action only", per the header. Mounting a warning must not
    // itself phone home — that would make merely visiting a page reportable.
    setPage()
    const { sent } = await boot()
    expect(reportButton()).not.toBeNull()
    expect(sent).toEqual([])
  })

  it('a second click does not send a second report', async () => {
    setPage()
    const { sent } = await boot()
    const btn = reportButton()!
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.filter((m) => m.type === 'SUBMIT_THREAT_REPORT')).toHaveLength(1)
  })
})

describe('the bar only appears where it should', () => {
  it('does not mount on https', async () => {
    // The whole trigger is an insecure page. On https there is nothing to warn
    // about and a bar would be a false alarm on a government service.
    setPage({ protocol: 'https:' })
    document.body.innerHTML = `
      <form action="https://${GOV_HOST}/submit">
        <input type="password" name="clave" />
      </form>`
    await boot()
    expect(reportButton()).toBeNull()
  })

  it('does not mount when the user turned it off', async () => {
    setPage()
    await boot({ settings: { trustBarEnabled: false } })
    expect(reportButton()).toBeNull()
  })

  it('does not mount on a host the user already dismissed', async () => {
    setPage()
    await boot({ dismissed: [GOV_HOST] })
    expect(reportButton()).toBeNull()
  })

  it('does not mount on a non-government host', async () => {
    // `matches` is scoped to CR public-sector zones deliberately — "NEVER
    // <all_urls>". The runtime check is the second half of that promise, and
    // the one that still holds if the manifest widens.
    setPage({ host: 'shop.example.com' })
    await boot()
    expect(reportButton()).toBeNull()
  })

  it('does not mount twice on an SPA re-entry', async () => {
    setPage()
    await boot()
    expect(document.querySelectorAll('#attestto-trust-bar-host')).toHaveLength(1)
    await boot()
    expect(document.querySelectorAll('#attestto-trust-bar-host')).toHaveLength(1)
  })
})
