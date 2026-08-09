/**
 * Story 2.1 — `did:web` method-specific-id → the HTTPS URL to fetch, with the
 * SSRF host rules applied. Pure: builds and validates a string, fetches nothing.
 *
 * Spec: https://w3c-ccg.github.io/did-method-web/#read-resolve
 *   did:web:example.com              → https://example.com/.well-known/did.json
 *   did:web:example.com:u:alice      → https://example.com/u/alice/did.json
 *   did:web:example.com%3A8443       → host carries a percent-encoded port
 *
 * ── What this actually protects, and what it does not ──────────────────────
 *
 * The extension resolves a DID chosen by a WEB PAGE. Without constraints that
 * makes the service worker a request generator aimed wherever the page likes,
 * from inside the user's network, with the user's ambient position — the
 * classic SSRF shape. The rules below remove the easy targets:
 *
 *   - https only, and the scheme is ours to write, never the caller's
 *   - no userinfo (`user@host` puts an attacker-chosen authority after the `@`)
 *   - no IP literals, v4 or v6, in any of their spellings (dotted, bracketed,
 *     and the integer/octal/hex forms that `127.0.0.1` also has)
 *   - no single-label hosts (`localhost`, `metadata`, intranet short names)
 *   - no reserved suffixes (`.local`, `.internal`, `.home.arpa`, …)
 *   - port 443 only — a did:web on :8443 is legal per spec but in practice a
 *     non-443 port on a resolvable host is an internal service far more often
 *     than it is a real identity endpoint. Documented tightening, not an
 *     oversight.
 *
 * 🩸 WHAT IS STILL OPEN, stated plainly rather than implied closed: none of
 * this stops a PUBLIC hostname whose DNS A record points at 169.254.169.254 or
 * 10.0.0.5. That is DNS rebinding, and an MV3 service worker cannot see the
 * resolved IP or pin it, so it cannot be closed at this layer. The mitigations
 * that DO bite are elsewhere and are load-bearing: the fetch adapter refuses
 * redirects (`redirect: 'error'`), and the resolver requires the returned
 * document's `id` to equal the DID that was asked for — so an internal service
 * that happens to answer with JSON still fails to become a DID document.
 * Treat a resolved doc as "this name said so", never as "this network location
 * is trustworthy".
 */

export type DidWebUrlReason =
  | 'empty-host'
  | 'userinfo-in-host'
  | 'invalid-host-characters'
  | 'ip-literal-host'
  | 'single-label-host'
  | 'reserved-suffix-host'
  | 'forbidden-port'
  | 'invalid-percent-encoding'
  | 'path-traversal'

export type BuildDidWebUrlResult =
  | { ok: true; value: string }
  | { ok: false; reason: DidWebUrlReason }

/**
 * Suffixes that never name a public host. `.local` is mDNS, `.internal` is the
 * GCP metadata convention, `.home.arpa` is RFC 8375, and the rest are RFC 6761
 * special-use names.
 */
const RESERVED_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.lan',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
] as const

/** Hosts that are reserved outright rather than by suffix. */
const RESERVED_HOSTS = ['localhost'] as const

/** LDH (letter-digit-hyphen) plus dots — the only host shape we will build. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/** Dotted-quad, e.g. `127.0.0.1`. Checked before the LDH test, which admits it. */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * The integer / octal / hex spellings of an IPv4 address. `http://2130706433/`,
 * `http://0177.0.0.1/` and `http://0x7f000001/` all reach 127.0.0.1, and none of
 * them is caught by a dotted-quad regex. A host whose labels are ALL numeric (in
 * any base) is never a real DNS name, so reject the whole class.
 */
function isNumericHost(host: string): boolean {
  const labels = host.split('.')
  return labels.every((label) => /^(0[xX][0-9a-fA-F]+|\d+)$/.test(label))
}

/** Percent-decode, reporting malformed sequences instead of throwing. */
function percentDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Build the HTTPS URL for a `did:web` method-specific-id.
 *
 * `methodSpecificId` must already have passed `parseDid` — this function assumes
 * idchar-only segments and no path/query/fragment characters, and enforces the
 * host rules on top.
 */
export function buildDidWebUrl(methodSpecificId: string): BuildDidWebUrlResult {
  const [rawHost, ...rawPathSegments] = methodSpecificId.split(':')

  const decodedHost = percentDecode(rawHost)
  if (decodedHost === null) return { ok: false, reason: 'invalid-percent-encoding' }
  if (decodedHost.length === 0) return { ok: false, reason: 'empty-host' }

  // Userinfo checked before the port split: `user@host:443` must not be read as
  // host `user@host`, and `@` is not an idchar so it can only arrive percent-
  // encoded — i.e. deliberately.
  if (decodedHost.includes('@')) return { ok: false, reason: 'userinfo-in-host' }

  // A bracketed IPv6 literal (`[::1]`) — reject before anything tries to parse it.
  if (decodedHost.includes('[') || decodedHost.includes(']')) {
    return { ok: false, reason: 'ip-literal-host' }
  }

  // Split the optional port. An IPv6 literal would make this ambiguous, but the
  // bracket check above has already removed that case.
  const portSplit = decodedHost.lastIndexOf(':')
  let host = decodedHost
  let port: string | null = null
  if (portSplit !== -1) {
    host = decodedHost.slice(0, portSplit)
    port = decodedHost.slice(portSplit + 1)
  }

  // Port 443 only. An explicit `:443` is redundant but legal, so accept it and
  // then omit it from the URL we build.
  if (port !== null && port !== '443') return { ok: false, reason: 'forbidden-port' }

  const lowerHost = host.toLowerCase()

  if (lowerHost.length === 0) return { ok: false, reason: 'empty-host' }
  if (IPV4_RE.test(lowerHost) || isNumericHost(lowerHost)) {
    return { ok: false, reason: 'ip-literal-host' }
  }
  if (!HOST_RE.test(lowerHost)) return { ok: false, reason: 'invalid-host-characters' }
  if (RESERVED_HOSTS.includes(lowerHost as (typeof RESERVED_HOSTS)[number])) {
    return { ok: false, reason: 'reserved-suffix-host' }
  }
  // No dot = a single-label intranet name (`metadata`, `wiki`, `router`), which
  // only resolves inside a private network.
  if (!lowerHost.includes('.')) return { ok: false, reason: 'single-label-host' }
  if (RESERVED_SUFFIXES.some((suffix) => lowerHost.endsWith(suffix))) {
    return { ok: false, reason: 'reserved-suffix-host' }
  }

  // Path segments. Each is percent-decoded per spec; `.`/`..` and any decoded
  // separator would let a crafted DID climb out of the intended path or switch
  // hosts, so they are rejected rather than normalised away.
  const pathSegments: string[] = []
  for (const rawSegment of rawPathSegments) {
    const segment = percentDecode(rawSegment)
    if (segment === null) return { ok: false, reason: 'invalid-percent-encoding' }
    if (segment.length === 0) return { ok: false, reason: 'path-traversal' }
    if (segment === '.' || segment === '..') return { ok: false, reason: 'path-traversal' }
    if (segment.includes('/') || segment.includes('\\')) return { ok: false, reason: 'path-traversal' }
    if (segment.includes('?') || segment.includes('#')) return { ok: false, reason: 'path-traversal' }
    pathSegments.push(encodeURIComponent(segment))
  }

  const path =
    pathSegments.length === 0 ? '/.well-known/did.json' : `/${pathSegments.join('/')}/did.json`

  return { ok: true, value: `https://${lowerHost}${path}` }
}
