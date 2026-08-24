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
 * 4. **A device that cannot do PRF is refused, not downgraded.** There is no
 *    passphrase to fall back to, so `PRF_UNSUPPORTED` must reach the user as
 *    "this device cannot secure a wallet" — never as a password field.
 * 5. **The retry path does not bypass the signing gate.** `setupPasskeyAndRetry`
 *    ends by calling `approve()`, so the ATT-1098 verification must still run.
 *    A retry that skipped it would be a bypass reachable by failing once on
 *    purpose.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const requireUserVerification = vi.fn()
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
  error: string | null
  showResetVault: boolean
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

describe('the retry path does not bypass the signing gate', () => {
  it('still requires fresh user verification after enrolling a passkey', async () => {
    walletState.isUnlocked = true
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

/**
 * What a device that cannot do PRF is told, at every place the approval window
 * can meet one.
 *
 * These replace the deleted "passphrase guards" cases. Those guarded a field
 * that no longer exists; the branches they covered are gone with it. What
 * matters now is the opposite property — that the refusal is stated as a
 * refusal, and never reopens a password as an escape hatch. Without these the
 * new `PRF_UNSUPPORTED` handlers were the only untested branches in this file.
 */
describe('an authenticator that cannot secure a wallet', () => {
  it('🔒 tells the user plainly when enrolling a passkey is impossible here', async () => {
    enrollPasskey.mockRejectedValue(new Error('PRF_UNSUPPORTED: …'))
    const vm = await mountApproval()

    await vm.setupPasskeyAndRetry()
    await flushPromises()

    expect(vm.error).toMatch(/cannot secure a wallet/i)
    expect(
      vm.error,
      'the refusal offered a password instead — the fallback this flow deleted',
    ).not.toMatch(/passphrase|password/i)
    expect(sent.filter((m) => APPROVE_TYPES.includes(m.type))).toEqual([])
  })

  it('🔒 tells the user plainly when creating a DID is impossible here', async () => {
    createDid.mockRejectedValue(new Error('PRF_UNSUPPORTED: …'))
    const vm = await mountApproval()

    await vm.createDidAndRetry()
    await flushPromises()

    expect(vm.error).toMatch(/cannot secure a wallet/i)
    expect(vm.error).not.toMatch(/passphrase|password/i)
  })

  it('offers reset, not a password, when the existing vault will not open', async () => {
    // `PRF_UNAVAILABLE` means the vault exists and this authenticator cannot
    // reproduce its key. The vault is disposable, so reset is the whole recovery
    // story — there is nothing else to offer and nothing irreplaceable lost.
    walletState.isUnlocked = false
    walletState.unlock.mockRejectedValue(new Error('PRF_UNAVAILABLE: …'))
    const vm = await mountApproval()

    await vm.approve()
    await flushPromises()

    expect(vm.showResetVault).toBe(true)
    expect(vm.error).toMatch(/reset/i)
    expect(sent.filter((m) => APPROVE_TYPES.includes(m.type))).toEqual([])
  })

  it('a cancelled authenticator stays retryable rather than becoming an error state', async () => {
    enrollPasskey.mockRejectedValue(new DOMException('nope', 'NotAllowedError'))
    const vm = await mountApproval()

    await vm.setupPasskeyAndRetry()
    await flushPromises()

    expect(vm.error).toMatch(/cancelled/i)
    expect(vm.error).not.toMatch(/passphrase|password/i)
  })
})
