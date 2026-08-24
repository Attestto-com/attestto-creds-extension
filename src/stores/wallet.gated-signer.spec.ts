/**
 * SOC-279 part 2 — the popup signs through one gated signer, and the raw key
 * does not leave the wallet store.
 *
 * Before this, `getPrivateKey()` returned the private JWK to any caller in the
 * popup context. Two views built their own signer from it and a third signed
 * inline with `crypto.subtle`. AD-11c asks for one signing primitive per
 * context; "hand out the key and trust every caller" is the arrangement it
 * exists to replace — the background solved the same problem by keeping the key
 * inside a `rawSign` closure.
 *
 * ── An honest note on what this file proves ───────────────────────────────
 *
 * These are SOURCE assertions, not behavioural ones. The store's key is module
 * -private and only populated by a real passkey unlock, so exercising the
 * signer for real means standing up WebAuthn, WebCrypto and chrome.storage — at
 * which point the test is mostly stubs agreeing with each other.
 *
 * So this pins the two things a source read can actually settle: that no raw-key
 * accessor is exported, and that the gate is invoked before the signature inside
 * the signer. It does NOT prove ordering at runtime. A behavioural test that
 * rejects the gate and asserts no signature is produced is the stronger follow
 * -up, and it is worth writing when the store gains a seam for injecting the
 * gate. Recorded rather than quietly skipped.
 *
 * `gate-self-test.mjs` seeds the removal of the `requireUserVerification` call
 * and requires this file to redden.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const walletSource = (): string => readFileSync(resolve(__dirname, './wallet.ts'), 'utf8')

describe('SOC-279 — the wallet store does not hand out key material', () => {
  it('exposes no raw-key accessor', () => {
    const source = walletSource()
    // The store returns a big object literal; `getPrivateKey,` in it was the
    // export. `getPublicKeyJwk` stays — public material is not the concern.
    expect(source).not.toMatch(/^\s*getPrivateKey,\s*$/m)
  })

  it('offers a gated signer in its place', () => {
    expect(walletSource()).toMatch(/^\s*createGatedSigner,\s*$/m)
  })

  it('the gated signer verifies the user before signing', () => {
    const source = walletSource()
    const start = source.indexOf('function createGatedSigner')
    expect(start).toBeGreaterThan(-1)

    // Read only the signer's own body, so an unrelated UV call elsewhere in the
    // store cannot satisfy this.
    const body = source.slice(start, source.indexOf('\n  }', start))
    expect(body).toContain('await requireUserVerification()')

    // Ordering, as far as source can settle it: the gate appears before the
    // signature. Runtime ordering is the follow-up noted in the header.
    expect(body.indexOf('await requireUserVerification()')).toBeLessThan(
      body.indexOf('es256KeySigner'),
    )
  })

  it('no popup module reaches for the key directly any more', () => {
    for (const file of [
      'src/stores/proof-requests.ts',
      'src/views/credentials/PresentCredentialView.vue',
    ]) {
      const source = readFileSync(resolve(__dirname, '../..', file), 'utf8')
      expect(source, `${file} still calls getPrivateKey`).not.toContain('getPrivateKey()')
      expect(source, `${file} still builds its own signer`).not.toContain('es256KeySigner(')
    }
  })
})
