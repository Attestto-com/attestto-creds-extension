import { describe, it, expect, vi, afterEach } from 'vitest'
import { STORAGE_KEYS } from '@/config/app'
import { setupPasskey } from './webauthn'

/**
 * Passkey-first, proven — and now passkey-ONLY.
 *
 * `setupPasskey` derives the vault encryption key, which makes it the most
 * consequential function in the product.
 *
 * The invariant this file pins is no longer "PRF is attempted before a
 * passphrase" — there is no passphrase. It is stronger:
 *
 *   **The registration response is never treated as the last word on PRF.**
 *
 * That is the defect these tests exist for. Chrome answers `create()` with
 * `prf: { enabled: true }` and NO `results` on every platform authenticator;
 * the secret only ever comes back from an assertion. Reading `results.first`
 * off the registration response and giving up declared PRF unsupported on
 * Touch ID, Windows Hello and iCloud Keychain alike — which is how a password
 * field ended up in a flow that is supposed to have none.
 */

const PRF_BYTES = new Uint8Array(32).fill(7).buffer

function storage(initial: Record<string, unknown> = {}) {
  const local = { ...initial }
  const session: Record<string, unknown> = {}
  return {
    local,
    session,
    chrome: {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys]
            const out: Record<string, unknown> = {}
            for (const k of list) if (k in local) out[k] = local[k]
            return out
          }),
          set: vi.fn(async (entries: Record<string, unknown>) => {
            Object.assign(local, entries)
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k]
          }),
        },
        session: {
          set: vi.fn(async (entries: Record<string, unknown>) => {
            Object.assign(session, entries)
          }),
        },
      },
    },
  }
}

/** What `getClientExtensionResults()` hands back, per call. */
type PrfShape = 'results' | 'enabled-only' | 'enabled-false' | 'silent'

function extResults(shape: PrfShape): Record<string, unknown> {
  switch (shape) {
    case 'results': return { prf: { results: { first: PRF_BYTES } } }
    case 'enabled-only': return { prf: { enabled: true } }
    case 'enabled-false': return { prf: { enabled: false } }
    case 'silent': return {}
  }
}

/**
 * Stub both WebAuthn calls independently, because the whole point is that they
 * report PRF DIFFERENTLY — `create` announces capability, `get` produces the
 * secret. A helper that forced them to agree could not express the bug.
 */
function stubWebAuthn(opts: { onCreate: PrfShape; onGet: PrfShape }) {
  const create = vi.fn(async () => ({
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    getClientExtensionResults: () => extResults(opts.onCreate),
  }))
  const get = vi.fn(async () => ({
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    getClientExtensionResults: () => extResults(opts.onGet),
  }))
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: { create, get },
  })
  return { create, get }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('setupPasskey — a fresh device', () => {
  /**
   * 🩸 THE REGRESSION. This is exactly what Chrome does on macOS Touch ID:
   * registration says "PRF works here", and says nothing else. Setup must go
   * and get the secret rather than concluding the device cannot do PRF.
   *
   * Mutation check: delete the `tryPrfAssertion` follow-up in `setupPasskey`
   * and this test fails with PRF_UNSUPPORTED — the exact user-visible symptom
   * (a password prompt on hardware that never needed one).
   */
  it('🔒 asks for an assertion when registration reports enabled but returns no secret', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    const { create, get } = stubWebAuthn({ onCreate: 'enabled-only', onGet: 'results' })

    const result = await setupPasskey()

    expect(create).toHaveBeenCalled()
    expect(get).toHaveBeenCalled() // the follow-up that the old code never made
    expect(result.aesKeyBase64).toBeTruthy()
    expect(s.session[STORAGE_KEYS.SESSION_KEY]).toBe(result.aesKeyBase64)
  })

  it('probes anyway when registration reports nothing about PRF at all', async () => {
    // Browsers disagree about whether `enabled` is reported. An absent flag is
    // "unknown", never "unsupported" — so it must not short-circuit.
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    const { get } = stubWebAuthn({ onCreate: 'silent', onGet: 'results' })

    const result = await setupPasskey()

    expect(get).toHaveBeenCalled()
    expect(result.aesKeyBase64).toBeTruthy()
  })

  it('takes the secret straight from registration when one is offered', async () => {
    // An authenticator that DOES evaluate at creation time must not be made to
    // verify the user a second time for nothing.
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    const { get } = stubWebAuthn({ onCreate: 'results', onGet: 'results' })

    const result = await setupPasskey()

    expect(result.aesKeyBase64).toBeTruthy()
    expect(get).not.toHaveBeenCalled()
  })

  it('persists the credential id and salt before PRF support is known', async () => {
    // A cancelled or interrupted attempt must leave enough behind for the retry
    // path to reuse the credential instead of stacking another one.
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubWebAuthn({ onCreate: 'enabled-only', onGet: 'results' })

    await setupPasskey()

    expect(s.local[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]).toBeTruthy()
    expect(s.local[STORAGE_KEYS.PRF_SALT]).toBeTruthy()
  })
})

/**
 * There is no passphrase, and refusing is the correct behaviour.
 *
 * A device that cannot produce a PRF secret cannot hold a vault. The old code
 * met that case with an Argon2id-over-passphrase vault, which unlocked without
 * any user verification and so made "passkey-protected" a claim nobody could
 * check. Failing closed is the honest outcome; downgrading silently is not.
 */
describe('setupPasskey — an authenticator that genuinely cannot do PRF', () => {
  it('🔒 fails closed instead of falling back to a passphrase', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubWebAuthn({ onCreate: 'enabled-false', onGet: 'silent' })

    await expect(setupPasskey()).rejects.toThrow(/PRF_UNSUPPORTED/)
  })

  it('skips the pointless extra prompt when support is explicitly denied', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    const { get } = stubWebAuthn({ onCreate: 'enabled-false', onGet: 'silent' })

    await expect(setupPasskey()).rejects.toThrow(/PRF_UNSUPPORTED/)
    expect(get).not.toHaveBeenCalled()
  })

  it('writes no session key when it refuses', async () => {
    // A half-finished setup that cached a key would leave the wallet in a state
    // where something could be encrypted under a key nothing can reproduce.
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubWebAuthn({ onCreate: 'enabled-false', onGet: 'silent' })

    await expect(setupPasskey()).rejects.toThrow()
    expect(s.session[STORAGE_KEYS.SESSION_KEY]).toBeUndefined()
  })
})

/**
 * The credential ID is persisted immediately on creation, before PRF support is
 * known, so a cancelled or interrupted first attempt leaves one behind. The
 * retry must reuse it — re-registering stacks orphan credentials the user then
 * sees forever in their password manager.
 */
describe('setupPasskey — retry after an interrupted attempt', () => {
  const interrupted = {
    [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: 'AQIDBA',
    [STORAGE_KEYS.PRF_SALT]: 'AQIDBA',
  }

  it('re-probes the existing credential and succeeds', async () => {
    const s = storage(interrupted)
    vi.stubGlobal('chrome', s.chrome)
    const { get } = stubWebAuthn({ onCreate: 'silent', onGet: 'results' })

    const result = await setupPasskey()

    expect(get).toHaveBeenCalled()
    expect(result.aesKeyBase64).toBeTruthy()
  })

  it('🔒 does not mint a second passkey on retry', async () => {
    const s = storage(interrupted)
    vi.stubGlobal('chrome', s.chrome)
    const { create } = stubWebAuthn({ onCreate: 'silent', onGet: 'results' })

    await setupPasskey()

    expect(create).not.toHaveBeenCalled()
  })

  it('fails closed when the re-probe finds no PRF', async () => {
    const s = storage(interrupted)
    vi.stubGlobal('chrome', s.chrome)
    stubWebAuthn({ onCreate: 'silent', onGet: 'silent' })

    await expect(setupPasskey()).rejects.toThrow(/PRF_UNSUPPORTED/)
  })

  /**
   * 🩸 THE DEAD END, pinned.
   *
   * `allowCredentials` pins the assertion to the stored credential, so while
   * that id remained in storage every retry re-prompted for the ONE passkey
   * that cannot work — no picker, no other authenticator, no way out of setup
   * from the UI. Observed in Brave, whose built-in passkey store has no PRF.
   */
  it('🔒 forgets a credential that cannot do PRF, so the next attempt can start over', async () => {
    const s = storage(interrupted)
    vi.stubGlobal('chrome', s.chrome)
    stubWebAuthn({ onCreate: 'silent', onGet: 'silent' })

    await expect(setupPasskey()).rejects.toThrow(/PRF_UNSUPPORTED/)

    expect(
      s.local[STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID],
      'the unusable credential id survived the failure, so the next attempt pins ' +
        'the assertion to it again and the user can never reach a working authenticator',
    ).toBeUndefined()
    expect(s.local[STORAGE_KEYS.PRF_SALT]).toBeUndefined()
  })

  it('a retry after that failure creates a new credential instead of re-probing', async () => {
    // The consequence of forgetting: `create()` runs, so the browser shows its
    // full picker and the user can choose a phone or security key.
    const s = storage(interrupted)
    vi.stubGlobal('chrome', s.chrome)
    stubWebAuthn({ onCreate: 'silent', onGet: 'silent' })
    await expect(setupPasskey()).rejects.toThrow(/PRF_UNSUPPORTED/)

    const second = stubWebAuthn({ onCreate: 'enabled-only', onGet: 'results' })
    const result = await setupPasskey()

    expect(second.create, 'the retry never offered a fresh ceremony').toHaveBeenCalled()
    expect(result.aesKeyBase64).toBeTruthy()
  })
})

/**
 * The ceremony must not be locked to this device's built-in passkey store.
 *
 * It used to pass `authenticatorAttachment: 'platform'`, which is why a browser
 * with a PRF-less built-in store showed its own prompt immediately and offered
 * no alternative. Unconstrained, the browser presents its picker — phone over
 * hybrid, security key — and those do implement hmac-secret.
 */
describe('setupPasskey — the user can reach an authenticator that works', () => {
  it('🔒 does not restrict registration to the platform authenticator', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    const { create } = stubWebAuthn({ onCreate: 'enabled-only', onGet: 'results' })

    await setupPasskey()

    const opts = (create.mock.calls.at(-1) as unknown[] | undefined)?.[0] as {
      publicKey?: { authenticatorSelection?: Record<string, unknown> }
    }
    const selection = opts?.publicKey?.authenticatorSelection
    expect(
      selection?.authenticatorAttachment,
      'pinning to `platform` leaves a user whose built-in store lacks PRF with no ' +
        'authenticator they can choose, and therefore no way to finish setup',
    ).toBeUndefined()
  })

  it('🔒 still requires user verification whatever the user picks', async () => {
    // Widening the choice must not weaken the property the signing gate rests on.
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    const { create } = stubWebAuthn({ onCreate: 'enabled-only', onGet: 'results' })

    await setupPasskey()

    const opts = (create.mock.calls.at(-1) as unknown[] | undefined)?.[0] as {
      publicKey?: { authenticatorSelection?: Record<string, unknown> }
    }
    expect(opts?.publicKey?.authenticatorSelection?.userVerification).toBe('required')
  })
})
