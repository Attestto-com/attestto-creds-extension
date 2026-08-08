/**
 * Story 1.6 — the WebAuthn-gated signing primitive (runtime channel).
 *
 * The CORE referent is fail-closed: when the presence gate throws, `rawSign` is
 * called ZERO times (Murat's point — order alone is vacuous; a swallowed gate
 * error that still signs is the real failure). Order and await-pinning are
 * corroborating, not primary.
 *
 * Pure factory: no `chrome.*`/`navigator.*` — the real gate
 * (`requireUserVerification`, fail-closed) is injected by the composition root
 * (Story 1.13). This file is the only importer of the factory in this story.
 */
import { describe, it, expect, vi } from 'vitest'
import { createGatedSign, type PresenceGate, type RawSign } from './gated-sign'
import type { Signature } from '@/background/ports/ports'

const sig = (n: number): Signature => ({ bytes: new Uint8Array([n]) })

describe('createGatedSign — happy path', () => {
  it('asserts presence, then returns the EXACT rawSign signature (no wrapping)', async () => {
    const out = sig(7)
    const assertPresence: PresenceGate = vi.fn(async () => {})
    const rawSign: RawSign = vi.fn(async () => out)
    const sign = createGatedSign({ assertPresence, rawSign })

    const result = await sign(new Uint8Array([1, 2, 3]))

    expect(result).toBe(out) // identity — nobody transforms the signature
    expect(assertPresence).toHaveBeenCalledTimes(1)
    expect(rawSign).toHaveBeenCalledTimes(1)
  })

  it('passes the payload through unchanged to rawSign', async () => {
    const payload = new Uint8Array([9, 8, 7])
    const rawSign: RawSign = vi.fn(async () => sig(1))
    const sign = createGatedSign({ assertPresence: async () => {}, rawSign })
    await sign(payload)
    expect(rawSign).toHaveBeenCalledWith(payload)
  })
})

describe('createGatedSign — FAIL-CLOSED (the story\'s core referent)', () => {
  it('gate throws → sign rejects and rawSign is NEVER called', async () => {
    const assertPresence: PresenceGate = vi.fn(async () => {
      throw new Error('USER_VERIFICATION_CANCELLED')
    })
    const rawSign: RawSign = vi.fn(async () => sig(1))
    const sign = createGatedSign({ assertPresence, rawSign })

    await expect(sign(new Uint8Array([1]))).rejects.toThrow('USER_VERIFICATION_CANCELLED')
    expect(rawSign).not.toHaveBeenCalled() // ← referent: no signature without presence
  })

  it('AWAIT-PINNED: a gate that rejects on a LATER tick still blocks rawSign', async () => {
    // If the factory did not `await` the gate, rawSign would fire before this
    // deferred rejection propagated. Asserting rawSign-zero pins the await.
    let rejectGate!: (e: unknown) => void
    const gatePromise = new Promise<void>((_res, rej) => { rejectGate = rej })
    const assertPresence: PresenceGate = () => gatePromise
    const rawSign: RawSign = vi.fn(async () => sig(1))
    const sign = createGatedSign({ assertPresence, rawSign })

    const signing = sign(new Uint8Array([1]))
    rejectGate(new Error('late cancel'))
    await expect(signing).rejects.toThrow('late cancel')
    expect(rawSign).not.toHaveBeenCalled()
  })
})

describe('createGatedSign — order corroboration', () => {
  it('asserts presence strictly before rawSign runs', async () => {
    const calls: string[] = []
    const assertPresence: PresenceGate = async () => { calls.push('gate') }
    const rawSign: RawSign = async () => { calls.push('sign'); return sig(1) }
    const sign = createGatedSign({ assertPresence, rawSign })
    await sign(new Uint8Array([1]))
    expect(calls).toEqual(['gate', 'sign'])
  })
})

describe('createGatedSign — purity (MV3/CSP guard, not the gate proof)', () => {
  it('the module imports with no chrome/navigator present', async () => {
    const g = globalThis as { chrome?: unknown; navigator?: unknown }
    const savedChrome = g.chrome
    const hadChrome = 'chrome' in g
    delete g.chrome
    try {
      await expect(import('./gated-sign')).resolves.toBeDefined()
    } finally {
      if (hadChrome) g.chrome = savedChrome
    }
  })
})
