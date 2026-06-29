/**
 * Homograph / brand-squat heuristic — Tier-A signals.
 *
 * ATT-716 Phase 1. Today this module surfaces two reachable signals:
 *
 *   yellow-heuristic  — domain uses punycode (IDN encoding), regardless
 *                       of whether it impersonates a known brand. Punycode
 *                       is rare in CR Latin-script context; flagging it
 *                       is high-precision in this market.
 *
 *   red               — domain's brand label exactly matches a registered
 *                       institution's brand AND the full host does NOT
 *                       match any registry entry (e.g., `bccr.online`
 *                       when the registry has `bccr.fi.cr`).
 *
 * Honest limits:
 *   - No punycode decoder shipped → we cannot tell "Latin a + Cyrillic а"
 *     in the rendered URL. Caught only when the browser shows xn-- form.
 *     ATT-716 Phase 2 ships a real Unicode-script analyzer.
 *   - False positives possible for legitimate brand reuse (e.g., a new
 *     subsidiary launching at `<brand>.com` before it's added to the
 *     registry). Acceptable for v0 — user can pin the new site to
 *     dismiss the warning.
 *   - Lookalike-via-typo (e.g., `bcrr.fi.cr` vs `bccr.fi.cr`) is NOT
 *     caught here — Levenshtein-style edit-distance work is Phase 2.
 */

import { lookupByBrand, lookupHost, brandLabelFromHost } from '@/utils/trust-registry'

export type HomographVerdict = 'red' | 'yellow-heuristic' | null

export async function homographState(host: string | null | undefined): Promise<HomographVerdict> {
  if (!host) return null
  const normalized = host.toLowerCase().replace(/^www\./, '')

  // Exact registry match — not a homograph, let other checks handle it.
  if (await lookupHost(normalized)) return null

  // Brand-squat: same brand label as a registered institution, different host.
  const brand = brandLabelFromHost(normalized)
  if (brand) {
    const matches = await lookupByBrand(normalized)
    if (matches.length > 0) {
      // The brand exists in the registry under different canonical hosts.
      // This is a strong impersonation signal in Latin-script context.
      return 'red'
    }
  }

  // Punycode (IDN) — rare in CR Latin-script context, flag conservatively.
  // Brand match on punycode would have been caught by the registry path
  // above; here we just signal "unusual encoding, caution warranted".
  if (containsPunycode(normalized)) {
    return 'yellow-heuristic'
  }

  return null
}

export function containsPunycode(host: string): boolean {
  return host.split('.').some((label) => label.startsWith('xn--'))
}
