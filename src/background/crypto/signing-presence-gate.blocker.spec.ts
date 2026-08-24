/**
 * SOC-279 — the service worker signs with a no-op presence gate, on purpose,
 * and this file is the reason that sentence is written down somewhere.
 *
 * `createSigningAdapters` used to default a missing `assertPresence` to an
 * anonymous `async () => {}`. The composition root never passed one, so the
 * shipped build took the default and the wiring read as complete. The gate was
 * documented as a passthrough in a header comment; nothing connected that
 * comment to the binding, and nothing failed if the comment went stale.
 *
 * Two changes make the deferral honest. `assertPresence` is now REQUIRED, so a
 * gate-less construction does not compile (see the type guard below). And the
 * worker binds `DEFERRED_PRESENCE_PASSTHROUGH`, a no-op with a name, a reason,
 * and a pointer to the protocol that replaces it.
 *
 * ── Why this is a blocker and not a to-do ─────────────────────────────────
 *
 * The obvious "fix" — import `requireUserVerification` into `background.ts` —
 * does not work and is not merely suboptimal: `navigator.credentials` does not
 * exist in an MV3 service worker, so it would throw at runtime and break every
 * signing path. The real WebAuthn UV runs in the approval window, which is a
 * document. Closing the gap needs the cross-process UV-proof protocol designed
 * in `_bmad-output/planning-artifacts/deferred/uv-proof-cross-process-liveness.md`.
 *
 * So: if someone swaps the passthrough, THIS test fails and points them at that
 * note — rather than the breakage surfacing as a wallet that cannot sign.
 * Same shape, and the same reasoning, as `did-sync-activation.blocker.spec.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createGatedSign, DEFERRED_PRESENCE_PASSTHROUGH } from './gated-sign'

const backgroundSource = (): string =>
  readFileSync(resolve(__dirname, '../../entrypoints/background.ts'), 'utf8')

describe('SOC-279 — the deferred presence gate is declared, not defaulted', () => {
  it('the passthrough verifies nothing, which is the whole point of naming it', async () => {
    // If this ever rejects, it has stopped being a passthrough and the tests
    // below are describing something that no longer exists.
    await expect(DEFERRED_PRESENCE_PASSTHROUGH(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined()
  })

  it('the composition root binds it BY NAME', () => {
    // The binding is the claim. A default would let this file pass while the
    // worker silently used an anonymous no-op — the state before SOC-279.
    expect(backgroundSource()).toContain('assertPresence: DEFERRED_PRESENCE_PASSTHROUGH')
  })

  it('the worker does NOT import the real WebAuthn gate — it would throw there', () => {
    // `requireUserVerification` calls navigator.credentials.get(), which is
    // undefined in a service worker. This is not a style rule; importing it
    // here breaks signing outright.
    expect(backgroundSource()).not.toMatch(/requireUserVerification/)
  })

  it('the gated primitive still fails closed when its gate rejects', () => {
    // The mechanism is sound and always was — the defect was never in
    // `createGatedSign`, it was in what the root handed it. Pinning that here
    // so a future change cannot quietly reorder assert-then-sign.
    const rejecting = async (): Promise<void> => {
      throw new Error('user absent')
    }
    let rawSignCalled = false
    const sign = createGatedSign({
      assertPresence: rejecting,
      rawSign: async () => {
        rawSignCalled = true
        return { bytes: new Uint8Array() }
      },
    })

    return expect(sign(new Uint8Array([1]))).rejects.toThrow('user absent').then(() => {
      expect(rawSignCalled).toBe(false)
    })
  })

  /**
   * The remaining gap, stated so it is not rediscovered as a surprise: an
   * `*_APPROVE` sent straight to the worker, bypassing the approval window,
   * still yields a signature with no human present. That is what the deferred
   * protocol closes, and its acceptance bar is a test asserting `rawSign` never
   * fires for a raw APPROVE with no/expired/replayed/mis-bound proof.
   *
   * Deliberately NOT asserted here as a `.todo`: a pending test reads as work
   * queued in this file, and the work belongs to its own story.
   */
})
