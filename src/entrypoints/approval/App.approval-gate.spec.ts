/**
 * The approval window is the whole boundary. This is its first test.
 *
 * `approval/App.vue` is the screen between a website asking for a signature and
 * the signature happening. It shipped at 0% coverage — 846 lines, no spec, and
 * no per-area threshold, so it could rot to nothing without reddening a build.
 * The background half is covered (`consent/approval-window.spec.ts`, 441 lines)
 * and the URL contract is covered (`approval-params.spec.ts`), which is exactly
 * what made the gap easy to miss: the two things either side of the window were
 * tested, and the window was not.
 *
 * ## What is asserted, and why these four
 *
 * The invariant that matters is not "the UI renders". It is **no `*_APPROVE`
 * message reaches the background unless a human was verified for this specific
 * approval**. Everything here is that claim from a different angle:
 *
 * 1. Verification refused (cancel, no authenticator) ⇒ NOTHING is dispatched.
 *    This is the ATT-1098 gate. If it regresses, an unlocked vault signs with
 *    no human present, because the session key is already cached.
 * 2. Verification is skipped ONLY for a PRF unlock, which performed a fresh
 *    WebAuthn user-verification to derive the key. A passphrase unlock proves
 *    knowledge of a secret, not presence, so it must still be challenged. The
 *    skip exists to avoid a double biometric prompt; it must not become a way
 *    to reach a signature with one.
 * 3. Auth carries no `selectedDid`. Sign-in uses a pairwise per-origin DID, so
 *    if the identity chooser ever leaked into the auth payload it would let a
 *    site correlate a user across origins — the thing pairwise DIDs exist to
 *    prevent.
 * 4. Deny dispatches the DENY for the mode on screen. A window that shows a
 *    payment and denies a CHAPI request leaves the payment hanging forever.
 *
 * ## Referents
 *
 * The real `resolveApprovalMode` parses real query strings, so a rename on the
 * background opener side breaks this spec rather than silently falling through
 * to "No request ID". The assertions are on the messages that actually reach
 * `chrome.runtime.sendMessage` — the same channel the background listens on —
 * not on component internals, which would pass with the dispatch removed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const requireUserVerification = vi.fn()
const getKdfMethod = vi.fn()
const recordTrustedOrigin = vi.fn()
const setPreferredIdentity = vi.fn()
const unlock = vi.fn()

/**
 * `isUnlocked` is a plain mutable property rather than a ref: the component
 * reads it once inside `approve()`, and a test needs to say "the vault is
 * already unlocked" without pulling in the real store's passkey machinery.
 */
const walletState = {
  isUnlocked: false,
  unlock,
  enrollPasskey: vi.fn(),
  loadPublicData: vi.fn(async () => {}),
  linkedIdentities: [] as unknown[],
  createDid: vi.fn(),
}

vi.mock('@/stores/wallet', () => ({ useWalletStore: () => walletState }))
vi.mock('@/utils/webauthn', () => ({
  requireUserVerification: (...a: unknown[]) => requireUserVerification(...a),
  getKdfMethod: (...a: unknown[]) => getKdfMethod(...a),
}))
vi.mock('@/utils/trusted-origins', () => ({
  isOriginTrusted: vi.fn(async () => false),
  recordTrustedOrigin: (...a: unknown[]) => recordTrustedOrigin(...a),
}))
vi.mock('@/utils/site-identity-prefs', () => ({
  getPreferredIdentity: vi.fn(async () => null),
  setPreferredIdentity: (...a: unknown[]) => setPreferredIdentity(...a),
}))
vi.mock('@/composables/useActivityReporter', () => ({ startActivityReporter: () => () => {} }))

import App from './App.vue'

/** Every message the component dispatched, in order. */
let sent: Array<{ type: string; payload?: Record<string, unknown> }>
let closed: number

/** The message types that authorise something. Nothing else may be dispatched. */
const APPROVE_TYPES = [
  'AUTH_APPROVE',
  'SIGN_ATTESTTO_PDF_APPROVE',
  'SIGN_DOCUMENT_APPROVE',
  'PAYMENT_APPROVE',
  'CHAPI_APPROVE',
  'CREDENTIAL_OFFER_APPROVE',
]

const approvalsSent = () => sent.filter((m) => APPROVE_TYPES.includes(m.type))

beforeEach(() => {
  setActivePinia(createPinia())
  sent = []
  closed = 0
  vi.clearAllMocks()

  walletState.isUnlocked = false
  walletState.linkedIdentities = []
  requireUserVerification.mockResolvedValue(undefined)
  getKdfMethod.mockResolvedValue('passphrase')

  ;(globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: async (msg: { type: string; payload?: Record<string, unknown> }) => {
        sent.push(msg)
        return { ok: true }
      },
    },
  }

  window.close = () => {
    closed += 1
  }
})

/**
 * Mount the real component against a real approval URL.
 *
 * `history.replaceState` is how the query string reaches
 * `resolveApprovalMode(window.location.search)` — the shipped parser, driven by
 * the same param names the background openers construct.
 */
async function mountApproval(query: string) {
  window.history.replaceState({}, '', `/approval.html?${query}`)
  const wrapper = mount(App)
  await flushPromises()
  return wrapper
}

const PAYMENT_URL =
  'paymentRequest=req-pay-1&origin=https%3A%2F%2Fshop.example&amount=42.50&currency=USDC&merchant=Shop'
const AUTH_URL = 'authRequest=req-auth-1&origin=https%3A%2F%2Fshop.example&siteName=Shop'

describe('approval window — the signing gate', () => {
  it('dispatches nothing when user verification is refused', async () => {
    walletState.isUnlocked = true
    requireUserVerification.mockRejectedValue(new Error('USER_VERIFICATION_CANCELLED'))

    const wrapper = await mountApproval(PAYMENT_URL)
    await (wrapper.vm as unknown as { approve: () => Promise<void> }).approve()
    await flushPromises()

    expect(
      approvalsSent(),
      'user verification was refused and an approval was dispatched anyway — ' +
        'an unlocked vault caches its session key, so this signs with no human present',
    ).toEqual([])
    expect(closed, 'the window closed on a refused verification').toBe(0)
  })

  it('still challenges the user when the vault unlocked by passphrase', async () => {
    walletState.isUnlocked = false
    unlock.mockResolvedValue(undefined)
    getKdfMethod.mockResolvedValue('passphrase')

    const wrapper = await mountApproval(PAYMENT_URL)
    await (wrapper.vm as unknown as { approve: () => Promise<void> }).approve()
    await flushPromises()

    expect(
      requireUserVerification,
      'a passphrase unlock proves knowledge of a secret, not that a human is present',
    ).toHaveBeenCalledTimes(1)
    expect(approvalsSent().map((m) => m.type)).toEqual(['PAYMENT_APPROVE'])
  })

  it('skips the second prompt only when the unlock itself verified the user (PRF)', async () => {
    walletState.isUnlocked = false
    unlock.mockResolvedValue(undefined)
    getKdfMethod.mockResolvedValue('prf')

    const wrapper = await mountApproval(PAYMENT_URL)
    await (wrapper.vm as unknown as { approve: () => Promise<void> }).approve()
    await flushPromises()

    expect(
      requireUserVerification,
      'a PRF unlock already performed a fresh WebAuthn user-verification',
    ).not.toHaveBeenCalled()
    expect(approvalsSent().map((m) => m.type)).toEqual(['PAYMENT_APPROVE'])
  })

  it('never carries a chosen identity on sign-in', async () => {
    walletState.isUnlocked = true

    const wrapper = await mountApproval(AUTH_URL)
    const vm = wrapper.vm as unknown as { selectedDid: string; approve: () => Promise<void> }
    // Force the chooser to hold a value. Auth must ignore it regardless: the
    // payload is built from the mode, not from whatever the ref happens to be.
    vm.selectedDid = 'did:jwk:leaked-cross-site-identity'
    await vm.approve()
    await flushPromises()

    const auth = sent.find((m) => m.type === 'AUTH_APPROVE')
    expect(auth, 'sign-in produced no approval').toBeTruthy()
    expect(
      auth?.payload?.selectedDid,
      'sign-in is pairwise per-origin — a chosen DID here is a cross-site correlation handle',
    ).toBeUndefined()
    expect(recordTrustedOrigin).toHaveBeenCalledWith('https://shop.example')
    expect(setPreferredIdentity, 'auth has no identity preference to remember').not.toHaveBeenCalled()
  })

  it('denies the request that is on screen', async () => {
    const wrapper = await mountApproval(PAYMENT_URL)
    await (wrapper.vm as unknown as { deny: () => Promise<void> }).deny()
    await flushPromises()

    expect(sent).toEqual([{ type: 'PAYMENT_DENY', payload: { requestId: 'req-pay-1' } }])
    expect(approvalsSent()).toEqual([])
    expect(closed).toBe(1)
  })

  it('denies sign-in as sign-in, not as the fallback mode', async () => {
    const wrapper = await mountApproval(AUTH_URL)
    await (wrapper.vm as unknown as { deny: () => Promise<void> }).deny()
    await flushPromises()

    // The deny type is a nested ternary whose default arm is CHAPI_DENY. If the
    // mode flags were ever mis-bound, every deny would silently become a CHAPI
    // deny and the real request would hang until its window timed out.
    expect(sent.map((m) => m.type)).toEqual(['AUTH_DENY'])
  })
})
