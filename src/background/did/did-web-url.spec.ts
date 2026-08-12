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
 * 🩸 Review finding (high). Wildcard-DNS services resolve an embedded address
 * with no registration, in dotted or dashed form. Every one of these is a
 * multi-label LDH name with a public suffix, so the IP-literal and suffix
 * checks were structurally incapable of seeing them — the octal/hex work above
 * raised the bar from "type an IP" to "type an IP with dashes".
 */
describe('buildDidWebUrl — wildcard-DNS IP encoders', () => {
  it.each([
    '169.254.169.254.nip.io',
    '169-254-169-254.sslip.io',
    '127-0-0-1.traefik.me',
    '10-1-2-3.nip.io',
    '192-168-0-1.localtest.me',
    '127.0.0.1.xip.io',
    '10.0.0.5.nip.io',
  ])('rejects %s', (host) => {
    expect(buildDidWebUrl(host)).toEqual({ ok: false, reason: 'ip-literal-host' })
  })

  it('rejects the shape, not a service blocklist', () => {
    // A wildcard service nobody has heard of must fail the same way — the
    // control is the dashed/dotted quad, not the domain.
    expect(buildDidWebUrl('169-254-169-254.some-new-service.example').ok).toBe(false)
    expect(buildDidWebUrl('10.0.0.5.whatever.test').ok).toBe(false)
  })

  it('does not reject an ordinary host that merely contains digits and dashes', () => {
    // Positive control: without this, rejecting everything would pass the block.
    expect(buildDidWebUrl('id-2.example.org').ok).toBe(true)
    expect(buildDidWebUrl('web3-wallet.example.com').ok).toBe(true)
    expect(buildDidWebUrl('a1-b2-c3.example.com').ok).toBe(true)
  })
})

/**
 * 🩸 Review finding (high). The old list's comment claimed RFC 6761 coverage
 * while containing none of those names. Each of these was demonstrated
 * reachable.
 */
describe('buildDidWebUrl — reserved zones the old list missed', () => {
  it.each([
    // The canonical in-cluster Kubernetes API server — and it listens on 443,
    // the one port this filter permits.
    'kubernetes.default.svc',
    'vault.service.consul',
    'x.test',
    'x.invalid',
    'x.example',
    'x.onion',
    'x.alt',
    'x.arpa',
    'host.localdomain',
    'thing.cluster',
    'svc.mesh',
    'pc.workgroup',
    'box.domain',
    'router.dhcp',
  ])('rejects %s', (host) => {
    expect(buildDidWebUrl(host)).toEqual({ ok: false, reason: 'reserved-suffix-host' })
  })

  it('reserves .arpa as a whole, not only its three named sub-zones', () => {
    expect(buildDidWebUrl('x.arpa').ok).toBe(false)
    expect(buildDidWebUrl('1.2.3.4.in-addr.arpa').ok).toBe(false)
    expect(buildDidWebUrl('nas.home.arpa').ok).toBe(false)
  })
})

/**
 * 🩸 Review finding (medium). `toLowerCase()` is Unicode-aware: U+212A KELVIN
 * SIGN folds to ASCII 'k', so a DID containing no ASCII 'k' fetched a host that
 * did. The host on the wire differed from the host the DID named.
 */
describe('buildDidWebUrl — Unicode case folding cannot change the host', () => {
  it('rejects the KELVIN SIGN rather than folding it to k', () => {
    // %E2%84%AA is U+212A. Previously emitted kubernetes.default.svc.
    expect(buildDidWebUrl('%E2%84%AAubernetes.default.svc')).toEqual({
      ok: false,
      reason: 'invalid-host-characters',
    })
    expect(buildDidWebUrl('loca%E2%84%AAhost.com')).toEqual({
      ok: false,
      reason: 'invalid-host-characters',
    })
  })

  it('never emits a host containing a character absent from the input', () => {
    // The structural version: whatever comes out is ASCII from the input.
    const result = buildDidWebUrl('%E2%84%AAubernetes.default.svc')
    if (result.ok) expect(result.value).not.toContain('kubernetes')
    expect(result.ok).toBe(false)
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

  /**
   * 🩸 Review finding. The checks see ONE decoding round. `%252e%252e%252f`
   * survived onto the wire as `%252e%252e%252f`, which a server or proxy that
   * decodes twice reads as `../../`.
   */
  it.each([
    'example.com:%252e%252e%252f%252e%252e%252fadmin',
    'example.com:%252e%252e',
    'example.com:%252f',
    'example.com:%2525',
  ])('rejects the double-encoded %j', (msid) => {
    expect(buildDidWebUrl(msid)).toEqual({ ok: false, reason: 'path-traversal' })
  })

  it('never emits a residual percent sequence that could decode again', () => {
    // Independent referent: scan the emitted URL for a double-encoded marker.
    const result = buildDidWebUrl('example.com:%252e%252e%252fadmin')
    if (result.ok) expect(result.value).not.toContain('%252')
    expect(result.ok).toBe(false)
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
