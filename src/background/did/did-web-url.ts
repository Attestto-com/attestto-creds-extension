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
 * 🩸 WHAT IS STILL OPEN, corrected after review found the previous note
 * overstated its own defences:
 *
 * None of this stops a PUBLIC hostname whose A record points at 10.0.0.5. The
 * attacker chooses the DID and controls DNS for the name inside it, so a single
 * static record is enough — there is no time-of-check/time-of-use race to win,
 * because nothing here resolves an IP to check. The request IS the SSRF
 * primitive, and it is sent before any of the response-side controls run.
 *
 * The previous version of this comment claimed the `id` equality check in
 * `did-document.ts` "bounds DNS rebinding". That is substantially false and has
 * been removed. The `id` check bounds a DIFFERENT attack — an unrelated internal
 * JSON endpoint being ADOPTED as a DID document — and it is worth keeping for
 * that. But it governs BELIEF, not network reach, and it operates after the
 * packet has left. Where the attacker authors both the DID and the document,
 * they satisfy it trivially.
 *
 * What actually bounds this layer: HTTPS with public-CA validation (an internal
 * appliance rarely holds a valid cert for the name), `redirect: 'error'`, port
 * 443 only, and — today — the fact that `host_permissions` in `wxt.config.ts`
 * covers only Costa Rican government TLDs, so CORS makes any other response
 * unreadable and the SSRF blind. That last one is an accident of scope, not a
 * control. When OID4VP needs broader permissions, this filter becomes the sole
 * defence and the blind-only property is lost. Widen host_permissions
 * deliberately, and re-read this comment when you do.
 *
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
 * Suffixes that never name a host we should fetch a DID document from.
 *
 * 🩸 The previous list's comment claimed "the rest are RFC 6761 special-use
 * names" while the array contained none of them — `.test`, `.invalid` and
 * `.example` were all admitted. A control whose documentation asserts coverage
 * the code does not have is worse than an honest gap, because it stops anyone
 * from looking. Review demonstrated each one.
 *
 * Three groups, all found by review to be reachable before this change:
 *   RFC 6761/7686/9476 special-use  .test .invalid .example .localhost .onion .alt
 *   service-discovery zones          kubernetes.default.svc is the canonical
 *                                    in-cluster API server AND it listens on 443,
 *                                    the one port this filter permits; .consul is
 *                                    HashiCorp's zone
 *   DHCP/router defaults             .localdomain (dnsmasq), .lan, .home, .domain
 *
 * `.arpa` is reserved WHOLE rather than by its three sub-zones — the previous
 * list named `.in-addr.arpa`, `.ip6.arpa` and `.home.arpa` and let `x.arpa` past.
 */
const RESERVED_SUFFIXES = [
  // RFC 6761 / 7686 / 9476 special-use
  '.test',
  '.invalid',
  '.example',
  '.localhost',
  '.onion',
  '.alt',
  '.local',
  '.arpa',
  // service discovery / orchestration
  '.svc',
  '.consul',
  '.mesh',
  '.cluster',
  // enterprise + DHCP/router defaults
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.lan',
  '.localdomain',
  '.domain',
  '.workgroup',
  '.dhcp',
] as const

/**
 * 🩸 Wildcard-DNS IP encoders — the finding that made the IP-literal work above
 * mostly decorative.
 *
 * `nip.io`, `sslip.io`, `traefik.me` and friends resolve any embedded address to
 * that address, in dotted OR dashed form, with no registration:
 *
 *     169.254.169.254.nip.io   -> 169.254.169.254
 *     169-254-169-254.sslip.io -> 169.254.169.254
 *     127-0-0-1.traefik.me     -> 127.0.0.1
 *
 * Every one is a multi-label LDH name with a public suffix, so `IPV4_RE`,
 * `isNumericHost` and the suffix list are all structurally incapable of seeing
 * them. Blocklisting the services is whack-a-mole — anyone can run one — so
 * reject the SHAPE instead: a host is refused when any label encodes a
 * dotted-quad in dashes, or when its leading labels spell one out.
 *
 * This is still not a complete defence. An attacker who owns a domain can point
 * an ordinary A record at 10.0.0.5 and nothing here can tell. See the
 * network-reach note at the top of this file — the host filter raises the cost,
 * it does not close the class.
 */
const DASHED_QUAD_LABEL_RE = /(^|[^0-9])(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})([^0-9]|$)/
const LEADING_DOTTED_QUAD_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\./

function encodesIpAddress(host: string): boolean {
  if (LEADING_DOTTED_QUAD_RE.test(host)) return true
  return host.split('.').some((label) => DASHED_QUAD_LABEL_RE.test(label))
}

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

  // 🩸 ASCII-only BEFORE case folding. `toLowerCase()` is Unicode-aware, so
  // U+212A KELVIN SIGN folds to ASCII 'k': review demonstrated that
  // `did:web:%E2%84%AAubernetes.default.svc` — which contains no ASCII 'k' —
  // emitted `https://kubernetes.default.svc/...`. The host fetched differed from
  // the host the DID named, which defeats any DID-string-level policy upstream
  // and multiplies cache keys for one URL. IDNA ToASCII is what would be
  // correct here; refusing non-ASCII is the honest subset of it.
  if (!/^[\x20-\x7E]*$/.test(host)) return { ok: false, reason: 'invalid-host-characters' }

  const lowerHost = host.toLowerCase()

  if (lowerHost.length === 0) return { ok: false, reason: 'empty-host' }
  if (IPV4_RE.test(lowerHost) || isNumericHost(lowerHost) || encodesIpAddress(lowerHost)) {
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
    // 🩸 Double encoding. The checks above see ONE decoding round, then
    // `encodeURIComponent` re-encodes the surviving `%`. Review showed
    // `%252e%252e%252f` reaching the wire as `%252e%252e%252f`, which a server
    // or proxy that decodes twice reads as `../../`. The module comment claimed
    // traversal was "rejected rather than normalised away" — true for one round
    // only. A residual `%` after decoding is never legitimate in a DID path
    // segment, so refuse it rather than guess at the decoding depth.
    if (segment.includes('%')) return { ok: false, reason: 'path-traversal' }
    pathSegments.push(encodeURIComponent(segment))
  }

  const path =
    pathSegments.length === 0 ? '/.well-known/did.json' : `/${pathSegments.join('/')}/did.json`

  return { ok: true, value: `https://${lowerHost}${path}` }
}
