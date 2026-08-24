/**
 * Story 1.13 Phase 1a — the composition-root bundle factory (AD-3/AD-11c).
 *
 * The invariant is NOT "the sign we call is gated" — it is (party F4, Vex):
 * "rawSign is reachable from NO bundle field except `crypto.sign`, and only after
 * the gate ran." THREE referents, none sufficient alone:
 *   1. PRIMARY — spy-reachability enumeration over every function-valued field of
 *      every bundle: the rawSign spy fires via EXACTLY ONE field (`crypto.sign`),
 *      and never before the gate. Covers the APDF/Ed25519 + AUTH/per-site slots
 *      explicitly (a per-bundle key-slot must not open a second sign path).
 *   2. SECONDARY — per-bundle gate-fires BOTH directions + payload-binding: reject
 *      ⇒ no rawSign; accept ⇒ rawSign once + gate saw the exact bytes.
 *   3. BACKSTOP — exactly one `createGatedSign` call-site in the source.
 *
 * Fresh-per-message: two `buildBundle('signing')` calls share NO key-slot (no bleed).
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createBuildBundle, type BundleAdapters } from './build-bundle'
import type { Signature } from '@/background/ports/ports'
import type { PresenceGate, RawSign } from '@/background/crypto/gated-sign'

const sig = (n: number): Signature => ({ bytes: new Uint8Array([n]) })
const accept: PresenceGate = async () => {}
const reject: PresenceGate = async () => {
  throw new Error('user declined')
}

/** A full adapter bag whose signing tier is instrumented so tests can watch rawSign. */
function makeAdapters(overrides: {
  assertPresence?: PresenceGate
  rootRawSign?: RawSign
  edRawSign?: RawSign
  siteRawSign?: RawSign
} = {}): { adapters: BundleAdapters; rootSpy: ReturnType<typeof vi.fn>; edSpy: ReturnType<typeof vi.fn>; siteSpy: ReturnType<typeof vi.fn>; gateSpy: ReturnType<typeof vi.fn> } {
  const rootSpy = vi.fn<RawSign>(async () => sig(1))
  const edSpy = vi.fn<RawSign>(async () => sig(2))
  const siteSpy = vi.fn<RawSign>(async () => sig(3))
  const gateSpy = vi.fn<PresenceGate>(overrides.assertPresence ?? accept)
  const adapters: BundleAdapters = {
    untrusted: {
      notifications: { create: vi.fn(async () => {}) },
      runtime: { sendMessage: vi.fn(async () => {}), getURL: vi.fn(() => 'x') },
    },
    consent: {
      pending: { put: vi.fn(async () => true), get: vi.fn(async () => null), markConsumed: vi.fn(async () => {}), takePending: vi.fn(async () => null), claimForProcessing: vi.fn(async () => ({ status: 'missing' as const })) },
      notify: { show: vi.fn(async () => {}) },
      clock: { now: vi.fn(() => 0) },
    },
    keyAdmin: {
      // SOC-280 — `vault` and `crypto` are gone from KeyAdminCtx: nothing used
      // them, and an unused signing surface on the key tier is a capability
      // waiting to be picked up by mistake. SOC-243 narrowed `Crypto` itself to
      // {sign} in the same window; both are strictly smaller surfaces and both
      // hold.
      store: { read: vi.fn(async () => null), write: vi.fn(async () => {}), syncPublic: vi.fn(async () => {}) },
      keygen: { generateP256: vi.fn(async () => ({ privateKeyJwk: {}, publicKeyJwk: {} })) },
      clock: { now: vi.fn(() => 0) },
    },
    signing: {
      store: { read: vi.fn(async () => null) },
      vault: { read: vi.fn(async () => ({ kind: 'v' })) },
      clock: { now: vi.fn(() => 1234) },
      pin: { pin: vi.fn(async () => {}) },
      assertPresence: gateSpy,
      rootRawSign: overrides.rootRawSign ?? rootSpy,
      provisionEd25519: vi.fn(async () => ({ publicKeyB64: 'ED', rawSign: overrides.edRawSign ?? edSpy })),
      provisionSiteDid: vi.fn(async () => ({ did: 'did:jwk:x', publicKeyJwk: {}, rawSign: overrides.siteRawSign ?? siteSpy })),
    },
  }
  return { adapters, rootSpy, edSpy, siteSpy, gateSpy }
}

describe('createBuildBundle — tag → bundle', () => {
  it('returns the right bundle shape per tag', () => {
    const { adapters } = makeAdapters()
    const build = createBuildBundle(adapters)
    expect(build('untrusted').notifications).toBeDefined()
    expect(build('consent').pending).toBeDefined()
    expect(build('keyAdmin').keygen).toBeDefined()
    const s = build('signing')
    expect(s.crypto.sign).toBeTypeOf('function')
    expect(s.provisioning.provisionEd25519).toBeTypeOf('function')
    expect(s.pin.pin).toBeTypeOf('function')
  })
})

describe('F4.2 — per-bundle gate fires BOTH directions + payload-binding', () => {
  it('reject ⇒ crypto.sign rejects and rawSign NEVER fires (root)', async () => {
    const { adapters, rootSpy, gateSpy } = makeAdapters({ assertPresence: reject })
    const s = createBuildBundle(adapters)('signing')
    await expect(s.crypto.sign(new Uint8Array([7]))).rejects.toThrow()
    expect(rootSpy).not.toHaveBeenCalled() // referent = the spy log, not the return
    expect(gateSpy).toHaveBeenCalledOnce()
  })

  it('accept ⇒ rawSign fires ONCE and the gate saw the EXACT bytes (payload-binding)', async () => {
    const { adapters, rootSpy, gateSpy } = makeAdapters({ assertPresence: accept })
    const s = createBuildBundle(adapters)('signing')
    const payload = new Uint8Array([11, 22, 33])
    await s.crypto.sign(payload)
    expect(rootSpy).toHaveBeenCalledOnce()
    expect(gateSpy).toHaveBeenCalledOnce()
    expect(gateSpy.mock.calls[0][0]).toBe(payload) // gate bound to the SAME bytes handed to sign
  })
})

describe('F4 key-slot — provisioning rebinds the ONE gated signer (still gated)', () => {
  it('no provisioning ⇒ signs with ROOT', async () => {
    const { adapters, rootSpy, edSpy, siteSpy } = makeAdapters()
    const s = createBuildBundle(adapters)('signing')
    await s.crypto.sign(new Uint8Array([1]))
    expect(rootSpy).toHaveBeenCalledOnce()
    expect(edSpy).not.toHaveBeenCalled()
    expect(siteSpy).not.toHaveBeenCalled()
  })

  it('after provisionEd25519 ⇒ signs with ED, still through the gate', async () => {
    const { adapters, rootSpy, edSpy, gateSpy } = makeAdapters()
    const s = createBuildBundle(adapters)('signing')
    await s.provisioning.provisionEd25519()
    await s.crypto.sign(new Uint8Array([1]))
    expect(edSpy).toHaveBeenCalledOnce()
    expect(rootSpy).not.toHaveBeenCalled() // key-slot rebound, root NOT used
    expect(gateSpy).toHaveBeenCalledOnce() // the Ed path is STILL gated
  })

  it('after provisionSiteDid ⇒ signs with SITE key, still gated', async () => {
    const { adapters, rootSpy, siteSpy, gateSpy } = makeAdapters()
    const s = createBuildBundle(adapters)('signing')
    await s.provisioning.provisionSiteDid('https://x.com')
    await s.crypto.sign(new Uint8Array([1]))
    expect(siteSpy).toHaveBeenCalledOnce()
    expect(rootSpy).not.toHaveBeenCalled()
    expect(gateSpy).toHaveBeenCalledOnce()
  })

  it('FRESH per message: two signing bundles share NO key-slot (no bleed)', async () => {
    const { adapters, rootSpy, edSpy } = makeAdapters()
    const build = createBuildBundle(adapters)
    const a = build('signing')
    await a.provisioning.provisionEd25519() // bundle A → Ed
    const b = build('signing') // bundle B is fresh
    await b.crypto.sign(new Uint8Array([1]))
    expect(rootSpy).toHaveBeenCalledOnce() // B signs with ROOT, unaffected by A's provisioning
    expect(edSpy).not.toHaveBeenCalled()
  })
})

describe('F4.1 — spy-reachability enumeration (PRIMARY: no second sign path)', () => {
  it('the rawSign spy is reachable via EXACTLY ONE field (crypto.sign) across the signing bundle', async () => {
    const { adapters, rootSpy, edSpy, siteSpy } = makeAdapters()
    const s = createBuildBundle(adapters)('signing') as unknown as Record<string, unknown>

    // Track ALL THREE raw signers as one reachability set: walking `provisioning.*`
    // rebinds the key-slot, so a leaked slot-reading field would fire whichever
    // signer is current — tracking only root would miss it (a real vacuity gap the
    // mutation-test caught). `provision*` REBIND but never SIGN, so they never count.
    const totalSigns = (): number =>
      rootSpy.mock.calls.length + edSpy.mock.calls.length + siteSpy.mock.calls.length

    // GENERICALLY walk the WHOLE bundle graph (top-level fields AND one level of
    // nested members) — NOT a hard-coded list — so a raw signer leaked as ANY field
    // is caught. Invoke each function with fuzz args; record the paths that sign.
    const firedVia: string[] = []
    const invoke = async (path: string, fn: unknown): Promise<void> => {
      if (typeof fn !== 'function') return
      const before = totalSigns()
      try {
        await (fn as (...a: unknown[]) => unknown)(new Uint8Array([1]), 'https://x.com')
      } catch {
        /* deriveForOrigin etc. may reject fuzz args — irrelevant to reachability */
      }
      if (totalSigns() > before) firedVia.push(path)
    }
    for (const [name, val] of Object.entries(s)) {
      await invoke(name, val) // top-level field (catches a leaked top-level signer)
      if (val && typeof val === 'object') {
        for (const [sub, fn] of Object.entries(val as Record<string, unknown>)) {
          await invoke(`${name}.${sub}`, fn) // nested member (catches crypto.rawSign etc.)
        }
      }
    }
    expect(firedVia).toEqual(['crypto.sign']) // the ONLY path that reaches a raw signer
  })
})

describe('F4.3 — backstop: exactly one createGatedSign call-site in the source', () => {
  it('source contains exactly one createGatedSign( invocation', () => {
    const src = readFileSync('src/background/ctx/build-bundle.ts', 'utf8')
    const calls = src.match(/createGatedSign\(/g) ?? []
    expect(calls).toHaveLength(1)
  })
})
