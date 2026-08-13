/**
 * The recovery paths out of a blocked approval. SOC-236.
 *
 * When signing is blocked — no passkey enrolled, no DID yet, a vault that will
 * not open — the approval window offers a way forward in place rather than a
 * dead end. Three of them: enrol a passkey and retry, create a DID and retry,
 * and reset the vault.
 *
 * They were untested, and they are the branches where a mistake is least
 * recoverable. `wallet.resetWallet()` calls `chrome.storage.local.clear()`:
 * vault, keys, linked identities, gone, with no backup taken and no undo. It is
 * reachable from a window a WEBSITE caused to open.
 *
 * ## What these assert
 *
 * 1. **One action never destroys a vault.** The first call arms a confirmation
 *    and returns; only a second, deliberate call resets. A guard that shows a
 *    confirmation prompt while still doing the work is the failure this pins.
 * 2. **Reset denies, never approves.** Destroying the signing key cannot be a
 *    way to authorise the request that prompted it.
 * 3. **A failed reset stays silent.** If the reset throws, the page is NOT told
 *    to abandon the request — the vault still exists, and reporting otherwise
 *    would make a live wallet look destroyed.
 * 4. **The passphrase guards block the call, not just the message.** A guard
 *    that sets `error` and then proceeds anyway looks identical in the UI and
 *    enrols with an empty passphrase.
 * 5. **The retry path does not bypass the signing gate.** `setupPasskeyAndRetry`
 *    ends by calling `approve()`, so the ATT-1098 verification must still run.
 *    A retry that skipped it would be a bypass reachable by failing once on
 *    purpose.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const requireUserVerification = vi.fn()
const getKdfMethod = vi.fn()
const resetWallet = vi.fn()
const enrollPasskey = vi.fn()
const createDid = vi.fn()

const walletState = {
  isUnlocked: true,
  unlock: vi.fn(),
  enrollPasskey,
  resetWallet,
  createDid,
  did: null as string | null,
  loadPublicData: vi.fn(async () => {}),
  linkedIdentities: [] as unknown[],
}

vi.mock('@/stores/wallet', () => ({ useWalletStore: () => walletState }))
vi.mock('@/utils/webauthn', () => ({
  requireUserVerification: (...a: unknown[]) => requireUserVerification(...a),
  getKdfMethod: (...a: unknown[]) => getKdfMethod(...a),
}))
vi.mock('@/utils/trusted-origins', () => ({
  isOriginTrusted: vi.fn(async () => false),
  recordTrustedOrigin: vi.fn(),
}))
vi.mock('@/utils/site-identity-prefs', () => ({
  getPreferredIdentity: vi.fn(async () => null),
  setPreferredIdentity: vi.fn(),
}))
vi.mock('@/composables/useActivityReporter', () => ({ startActivityReporter: () => () => {} }))

import App from './App.vue'

let sent: Array<{ type: string; payload?: Record<string, unknown> }>
let closed: number

const APPROVE_TYPES = [
  'AUTH_APPROVE',
  'SIGN_ATTESTTO_PDF_APPROVE',
  'SIGN_DOCUMENT_APPROVE',
  'PAYMENT_APPROVE',
  'CHAPI_APPROVE',
  'CREDENTIAL_OFFER_APPROVE',
]

beforeEach(() => {
  setActivePinia(createPinia())
  sent = []
  closed = 0
  vi.clearAllMocks()

  walletState.isUnlocked = true
  walletState.did = null
  requireUserVerification.mockResolvedValue(undefined)
  getKdfMethod.mockResolvedValue('prf')
  resetWallet.mockResolvedValue(undefined)
  enrollPasskey.mockResolvedValue(undefined)
  createDid.mockResolvedValue(undefined)

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

const PAYMENT_URL =
  'paymentRequest=req-pay-1&origin=https%3A%2F%2Fshop.example&amount=42.50&currency=USDC&merchant=Shop'

type Vm = {
  handleResetVault: () => Promise<void>
  setupPasskeyAndRetry: () => Promise<void>
  createDidAndRetry: () => Promise<void>
  approve: () => Promise<void>
  resetConfirm: boolean
  showPassphraseField: boolean
  showCreateDidPassphrase: boolean
  passphrase: string
  error: string | null
  selectedDid: string
}

async function mountApproval(query = PAYMENT_URL) {
  window.history.replaceState({}, '', `/approval.html?${query}`)
  const wrapper = mount(App)
  await flushPromises()
  return wrapper.vm as unknown as Vm
}

describe('vault reset — the destructive path', () => {
  it('arms a confirmation instead of destroying the vault on the first action', async () => {
    const vm = await mountApproval()

    await vm.handleResetVault()
    await flushPromises()

    expect(
      resetWallet,
      'the first reset action wiped chrome.storage.local — vault, keys and linked ' +
        'identities, with no backup and no undo, from a window a website opened',
    ).not.toHaveBeenCalled()
    expect(vm.resetConfirm, 'no confirmation was armed, so the user gets no second chance').toBe(true)
    expect(sent, 'a request was answered before the user confirmed').toEqual([])
    expect(closed).toBe(0)
  })

  it('resets only on the second, deliberate action', async () => {
    const vm = await mountApproval()

    await vm.handleResetVault()
    await flushPromises()
    await vm.handleResetVault()
    await flushPromises()

    expect(resetWallet).toHaveBeenCalledTimes(1)
    expect(closed).toBe(1)
  })

  it('denies the pending request and never approves it', async () => {
    const vm = await mountApproval()

    await vm.handleResetVault()
    await vm.handleResetVault()
    await flushPromises()

    expect(sent.map((m) => m.type)).toEqual(['PAYMENT_DENY'])
    expect(
      sent.filter((m) => APPROVE_TYPES.includes(m.type)),
      'destroying the signing key authorised the request that prompted the reset',
    ).toEqual([])
  })

  it('tells the page nothing when the reset itself fails', async () => {
    const vm = await mountApproval()
    resetWallet.mockRejectedValue(new Error('storage unavailable'))

    await vm.handleResetVault()
    await vm.handleResetVault()
    await flushPromises()

    expect(
      sent,
      'the reset failed and the request was abandoned anyway — the vault still ' +
        'exists, so the page was told a wallet was destroyed when it was not',
    ).toEqual([])
    expect(closed, 'the window closed on a failed reset, hiding the error').toBe(0)
    expect(vm.error).toBe('storage unavailable')
  })
})

describe('passphrase guards block the call, not just the message', () => {
  it('refuses to enrol a passkey with a too-short recovery passphrase', async () => {
    const vm = await mountApproval()
    // The field is only shown when the authenticator lacks PRF, which is
    // exactly when the passphrase is the sole recovery route. Enrolling with an
    // empty one re-mints a passkey, fails PRF again, and reads as "nothing
    // happened".
    vm.showPassphraseField = true
    vm.passphrase = 'short'

    await vm.setupPasskeyAndRetry()
    await flushPromises()

    expect(enrollPasskey, 'enrolled with a passphrase too weak to recover the vault').not.toHaveBeenCalled()
    expect(vm.error).toMatch(/8 characters/)
  })

  it('refuses to create a DID with a too-short recovery passphrase', async () => {
    const vm = await mountApproval()
    vm.showCreateDidPassphrase = true
    vm.passphrase = '1234567'

    await vm.createDidAndRetry()
    await flushPromises()

    expect(createDid, 'minted a vault whose only recovery secret is 7 characters').not.toHaveBeenCalled()
    expect(vm.error).toMatch(/8 characters/)
  })

  it('proceeds once the passphrase is long enough', async () => {
    const vm = await mountApproval()
    vm.showCreateDidPassphrase = true
    vm.passphrase = 'correct horse battery staple'

    await vm.createDidAndRetry()
    await flushPromises()

    // Control case. Without it, a guard that refused EVERYTHING would satisfy
    // both tests above and the recovery path would be a dead end.
    expect(createDid).toHaveBeenCalledWith('correct horse battery staple')
  })
})

describe('the retry path does not bypass the signing gate', () => {
  it('still requires fresh user verification after enrolling a passkey', async () => {
    walletState.isUnlocked = true
    getKdfMethod.mockResolvedValue('passphrase')
    const vm = await mountApproval()

    await vm.setupPasskeyAndRetry()
    await flushPromises()

    expect(enrollPasskey).toHaveBeenCalledTimes(1)
    expect(
      requireUserVerification,
      'the retry reached the approval dispatch without verifying the user — ' +
        'failing once on purpose would be a way around the ATT-1098 gate',
    ).toHaveBeenCalledTimes(1)
    expect(sent.map((m) => m.type)).toEqual(['PAYMENT_APPROVE'])
  })

  it('dispatches nothing when verification is refused on the retry', async () => {
    walletState.isUnlocked = true
    requireUserVerification.mockRejectedValue(new Error('USER_VERIFICATION_CANCELLED'))
    const vm = await mountApproval()

    await vm.setupPasskeyAndRetry()
    await flushPromises()

    expect(sent.filter((m) => APPROVE_TYPES.includes(m.type))).toEqual([])
    expect(closed).toBe(0)
  })
})
