/**
 * Story 1.10 — single-sourced pure label helper (AD-4).
 *
 * A human-readable label for a DID. Extracted verbatim from three byte-identical
 * copies (the `background.ts` closure used at two call sites, and a private
 * `extractDidLabel` in `stores/wallet.ts`) so the label rule lives in exactly one
 * place. Pure: a regex over the DID string, no I/O — hence a plain import, never a
 * port (AD-4).
 *
 *   - `did:sns:<suffix>`      → `<suffix>`
 *   - `did:web:<a>:<b>`       → `<a>/<b>`  (colons become slashes)
 *   - anything else           → the DID verbatim
 */
export function extractDidLabel(did: string): string {
  const snsMatch = did.match(/^did:sns:(.+)$/)
  if (snsMatch) return snsMatch[1]

  const webMatch = did.match(/^did:web:(.+)$/)
  if (webMatch) return webMatch[1].replace(/:/g, '/')

  return did
}
