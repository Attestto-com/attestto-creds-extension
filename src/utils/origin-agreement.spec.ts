/**
 * Story 1.3 (AD-15) — the origin consumers must key on a BYTE-IDENTICAL canonical
 * string, or a `:443`/trailing-slash variant passes one consumer's check yet lands
 * in a different pairwise-DID / trust bucket in another (AD-11a unlinkability split).
 *
 * The invariant was unguarded by FIVE byte-identical `${protocol}//${host}` copies.
 * This test is the independent referent that keeps them agreeing — trapped from
 * BOTH sides (logic party 2026-08-08):
 *   - variants that MUST collapse to one key: trailing-slash, path, fragment, and
 *     the scheme-DEFAULT port `:443`/`:80` (the live divergence Boundary found —
 *     `new URL().host` keeps an explicit `:443`);
 *   - a NON-default port `:4321` that must NOT collapse (guards local platform dev;
 *     a mutation that strips all ports fails here).
 *
 * Referent = each consumer's ACTUAL key under inputs a raw comparison splits — not
 * a hand-authored expected string (circular once all five share one util). The
 * mutation this bites on: any consumer re-pointed at a default-port-KEEPING
 * normalizer → the `:443` collapse breaks and this test names the split consumer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { normalizeOrigin, findOrCreateSiteDid } from '@/utils/site-did'
import { isPlatformOrigin } from '@/utils/platform-origins'
import { getSenderOrigin } from '@/utils/message-guard'
import { isOriginTrusted, recordTrustedOrigin } from '@/utils/trusted-origins'
import { getPreferredIdentity, setPreferredIdentity } from '@/utils/site-identity-prefs'

// In-memory chrome.storage.local for the two storage-backed consumers.
const store: Record<string, unknown> = {}
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: store[key] })),
      set: vi.fn(async (data: Record<string, unknown>) => {
        Object.assign(store, data)
      }),
    },
  },
})

// A web sender (has a tab → not an extension page → getSenderOrigin uses sender.origin).
const webSender = (origin: string) =>
  ({ origin, tab: { id: 1 } }) as unknown as chrome.runtime.MessageSender

describe('AD-15 — origin consumers agree on ONE canonical key', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
  })

  // Variants that MUST all collapse to the same canonical bucket.
  const COLLAPSE = [
    'https://app.attestto.com',
    'https://app.attestto.com/',
    'https://app.attestto.com/onboarding?next=/home',
    'https://app.attestto.com/#frag',
    'https://app.attestto.com:443', // scheme-default port — MUST collapse (the live gap)
  ]

  it('normalizeOrigin collapses every variant (incl. :443) to one key', () => {
    const keys = new Set(COLLAPSE.map((o) => normalizeOrigin(o)))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBe('https://app.attestto.com')
  })

  it('findOrCreateSiteDid (pairwise-DID bucket) keys identically across variants', async () => {
    const keys = new Set<string>()
    for (const o of COLLAPSE) {
      const { key } = await findOrCreateSiteDid({}, o)
      keys.add(key)
    }
    expect(keys.size).toBe(1)
  })

  it('getSenderOrigin (router-edge resolver) yields one key across variants', () => {
    const keys = new Set(COLLAPSE.map((o) => getSenderOrigin(webSender(o))))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBe('https://app.attestto.com')
  })

  it('isPlatformOrigin accepts the :443 variant identically to the port-less form', () => {
    // Before the fix `:443` is a distinct string not in the allowlist → false.
    for (const o of COLLAPSE) expect(isPlatformOrigin(o)).toBe(true)
  })

  it('trusted-origins: record under :443, read under port-less → same bucket (hit)', async () => {
    await recordTrustedOrigin('https://app.attestto.com:443')
    expect(await isOriginTrusted('https://app.attestto.com')).toBe(true)
  })

  it('site-identity-prefs: set under :443, read under port-less → same bucket', async () => {
    await setPreferredIdentity('https://app.attestto.com:443', 'did:jwk:xyz')
    expect(await getPreferredIdentity('https://app.attestto.com')).toBe('did:jwk:xyz')
  })

  // The other side of the trap: a NON-default port must NOT be stripped/collapsed.
  it('keeps a non-default port distinct (does NOT over-strip :4321)', () => {
    expect(normalizeOrigin('http://localhost:4321')).toBe('http://localhost:4321')
    expect(normalizeOrigin('http://localhost:4321')).not.toBe(normalizeOrigin('http://localhost'))
    // and the default :80 IS stripped, for symmetry with :443
    expect(normalizeOrigin('http://localhost:80')).toBe(normalizeOrigin('http://localhost'))
  })
})
