import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * Regression guard for the signing user-verification gate (ATT-1098).
 *
 * The wallet must require a fresh WebAuthn user-verification immediately before
 * every signing operation, because an already-unlocked vault caches its session
 * key and would otherwise sign with no human present. The gate lives in the
 * approval popup's `approve()` (`entrypoints/approval/App.vue`), which is the
 * single choke point for every signing dispatch (AUTH / SIGN / PAYMENT / CHAPI).
 *
 * This is a source guard rather than a component test: the concern is that a
 * later edit silently drops the gate or lets a signing dispatch run before it.
 * We assert the gate is present and precedes the signing message dispatch.
 */
const approveSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'entrypoints/approval/App.vue'),
  'utf8',
)

describe('signing user-verification gate (ATT-1098)', () => {
  it('requireUserVerification is called in the approval flow', () => {
    expect(approveSrc).toContain('requireUserVerification(')
  })

  it('the gate runs before the signing message is dispatched', () => {
    const gate = approveSrc.indexOf('requireUserVerification(')
    // The msgType assembly is the step that decides which *_APPROVE signing
    // message goes to the background signer.
    const dispatch = approveSrc.indexOf("? 'AUTH_APPROVE'")
    expect(gate).toBeGreaterThan(-1)
    expect(dispatch).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(dispatch)
  })

  it('credential-offer approval returns before the gate (offers are not signing)', () => {
    const offerReturn = approveSrc.indexOf('CREDENTIAL_OFFER_APPROVE')
    const gate = approveSrc.indexOf('requireUserVerification(')
    expect(offerReturn).toBeGreaterThan(-1)
    expect(offerReturn).toBeLessThan(gate)
  })
})
