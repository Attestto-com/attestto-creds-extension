import { describe, it, expect } from 'vitest'
import { buildDidWebUrl } from './did-web-url'

/**
 * Story 2.1 — `buildDidWebUrl`, the SSRF host filter.
 *
 * The independent referent here is the URL STRING that comes out, not a flag
 * the function sets: every positive case asserts the exact URL, so a builder
 * that returned `ok` while emitting a different host would fail.
 */
describe('buildDidWebUrl — spec-conformant construction', () => {
  it('maps a bare host to the well-known path', () => {
    expect(buildDidWebUrl('example.com')).toEqual({
      ok: true,
      value: 'https://example.com/.well-known/did.json',
    })
  })

  it('maps colon-separated segments to a path', () => {
    expect(buildDidWebUrl('example.com:users:alice')).toEqual({
      ok: true,
      value: 'https://example.com/users/alice/did.json',
    })
  })

  it('accepts an explicit :443 and omits it from the URL', () => {
    expect(buildDidWebUrl('example.com%3A443')).toEqual({
      ok: true,
      value: 'https://example.com/.well-known/did.json',
    })
  })

  it('lowercases the host', () => {
    expect(buildDidWebUrl('EXAMPLE.com')).toEqual({
      ok: true,
      value: 'https://example.com/.well-known/did.json',
    })
  })

  it('always builds https, never http', () => {
    const result = buildDidWebUrl('example.com')
    expect(result.ok && result.value.startsWith('https://')).toBe(true)
  })
})

/**
 * 🔒 The SSRF table. Each row is a target an attacker-chosen DID would
 * otherwise reach from inside the user's network.
 */
describe('buildDidWebUrl — SSRF host rejections', () => {
  it.each([
    // Loopback and link-local, spelled every way that resolves.
    ['127.0.0.1', 'ip-literal-host'],
    ['169.254.169.254', 'ip-literal-host'],
    ['10.0.0.5', 'ip-literal-host'],
    ['192.168.1.1', 'ip-literal-host'],
    ['0.0.0.0', 'ip-literal-host'],
    // Integer / octal / hex spellings of 127.0.0.1.
    ['2130706433', 'ip-literal-host'],
    ['0177.0.0.1', 'ip-literal-host'],
    ['0x7f000001', 'ip-literal-host'],
    // IPv6.
    ['%5B%3A%3A1%5D', 'ip-literal-host'],
    ['%5Bfd00%3A%3A1%5D', 'ip-literal-host'],
    // Single-label intranet names.
    ['localhost', 'reserved-suffix-host'],
    ['metadata', 'single-label-host'],
    ['router', 'single-label-host'],
    // Reserved suffixes.
    ['printer.local', 'reserved-suffix-host'],
    ['metadata.google.internal', 'reserved-suffix-host'],
    ['nas.home.arpa', 'reserved-suffix-host'],
    ['wiki.corp', 'reserved-suffix-host'],
    // Userinfo smuggling.
    ['evil.example%40internal.corp', 'userinfo-in-host'],
    // Non-443 ports.
    ['example.com%3A8443', 'forbidden-port'],
    ['example.com%3A22', 'forbidden-port'],
    ['example.com%3A0', 'forbidden-port'],
    // Malformed.
    ['%zz', 'invalid-percent-encoding'],
    ['%00example.com', 'invalid-host-characters'],
    ['exa_mple.com', 'invalid-host-characters'],
  ])('rejects host %j as %s', (msid, reason) => {
    expect(buildDidWebUrl(msid)).toEqual({ ok: false, reason })
  })

  it('rejects an empty host', () => {
    expect(buildDidWebUrl('')).toEqual({ ok: false, reason: 'empty-host' })
  })
})

/**
 * A decoded path segment must not be able to climb out of the path or change
 * the authority.
 */
describe('buildDidWebUrl — path traversal', () => {
  it.each([
    ['example.com:..:secret', 'path-traversal'],
    ['example.com:.', 'path-traversal'],
    ['example.com:%2e%2e', 'path-traversal'],
    ['example.com:%2Fetc%2Fpasswd', 'path-traversal'],
    ['example.com:a%23frag', 'path-traversal'],
    ['example.com:a%3Fq', 'path-traversal'],
  ])('rejects %j as %s', (msid, reason) => {
    expect(buildDidWebUrl(msid)).toEqual({ ok: false, reason })
  })

  it('re-encodes a decoded segment rather than emitting it raw', () => {
    const result = buildDidWebUrl('example.com:a%20b')
    // Decodes to `a b`, which must not appear unencoded in a URL.
    expect(result).toEqual({ ok: true, value: 'https://example.com/a%20b/did.json' })
  })

  it('cannot be made to emit a second authority', () => {
    // Every attempt to smuggle `//` into the path must fail rather than produce
    // `https://example.com//evil.example/did.json` (a protocol-relative jump).
    const result = buildDidWebUrl('example.com:%2F%2Fevil.example')
    expect(result).toEqual({ ok: false, reason: 'path-traversal' })
  })
})

/**
 * Mutation guard. If the host filter were removed wholesale, the positive tests
 * above would all still pass — only these would redden. Asserting the COUNT
 * makes a silently-weakened filter visible.
 */
describe('buildDidWebUrl — the filter as a whole', () => {
  const HOSTILE = [
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.5',
    '2130706433',
    '0x7f000001',
    '%5B%3A%3A1%5D',
    'localhost',
    'metadata',
    'printer.local',
    'metadata.google.internal',
    'evil.example%40internal.corp',
    'example.com%3A8443',
  ]

  it('rejects every hostile host in the table', () => {
    const accepted = HOSTILE.filter((h) => buildDidWebUrl(h).ok)
    expect(accepted).toEqual([])
  })

  it('still accepts an ordinary public host (the filter is not blanket-deny)', () => {
    // Without this, deleting the function body and returning a constant
    // rejection would pass every test above.
    expect(buildDidWebUrl('id.example.org').ok).toBe(true)
  })
})
