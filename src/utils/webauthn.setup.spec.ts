import { describe, it, expect, vi, afterEach } from 'vitest'
import { STORAGE_KEYS } from '@/config/app'
import { setupPasskey } from './webauthn'

/**
 * Passkey-first, proven.
 *
 * `setupPasskey` derives the vault encryption key, which makes it the most
 * consequential function in the product. It had NO test coverage: before this
 * file, `webauthn.spec.ts` covered only `requireUserVerification`.
 *
 * The invariant these tests pin: **PRF is attempted before a passphrase is
 * used, always.** A passphrase-derived vault is a deliberate fallback for
 * authenticators that cannot do PRF, never a shortcut taken because a
 * passphrase happened to be available.
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

/** A credential whose PRF extension either works or does not. */
function stubCreate(prfWorks: boolean) {
  const create = vi.fn(async () => ({
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    getClientExtensionResults: () =>
      prfWorks ? { prf: { results: { first: PRF_BYTES } } } : {},
  }))
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: { create, get: vi.fn() },
  })
  return create
}

/** An assertion against an ALREADY-REGISTERED credential. */
function stubGet(prfWorks: boolean) {
  const get = vi.fn(async () => ({
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    getClientExtensionResults: () =>
      prfWorks ? { prf: { results: { first: PRF_BYTES } } } : {},
  }))
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: { create: vi.fn(), get },
  })
  return get
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Five cases here call `setupPasskey(passphrase)`, which runs Argon2id at
 * 19 MiB and t=2 — deliberately expensive, and the cost is the point.
 *
 * Alone that is a few hundred milliseconds and the 5-second default was never
 * close. Under a loaded suite it is: adding eight tests elsewhere (SOC-145) was
 * enough to push "falls back to a passphrase only when PRF is genuinely absent"
 * past the default and fail it as a timeout, while the file passed on its own.
 *
 * That is a latent flake, not a defect this change introduced — a clean run of
 * `develop` passes twice, and so does this file in isolation. Raising the budget
 * here rather than making the new tests cheaper, because the slowness is real
 * and load-dependent: a test on the vault-key path that races the clock is worse
 * than no test, since it trains people to re-run instead of read.
 *
 * Same reasoning and same figure as `webauthn.unlock.spec.ts` (SOC-236).
 */
vi.setConfig({ testTimeout: 30_000 })

describe('setupPasskey — a fresh device', () => {
  it('uses PRF when the authenticator supports it', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubCreate(true)

    const result = await setupPasskey()

    expect(result.method).toBe('prf')
    expect(s.local[STORAGE_KEYS.KDF_METHOD]).toBe('prf')
  })

  it('🔒 uses PRF even when a passphrase was also supplied', async () => {
    // A user may type a passphrase into the setup form on a PRF-capable device.
    // That must not downgrade the vault: the passphrase is a FALLBACK, not a
    // preference, and a PRF vault unlocks with the passkey alone.
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubCreate(true)

    const result = await setupPasskey('a-passphrase-the-user-typed')

    expect(result.method).toBe('prf')
  })

  it('falls back to a passphrase only when PRF is genuinely absent', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubCreate(false)

    const result = await setupPasskey('fallback-passphrase')

    expect(result.method).toBe('passphrase')
    expect(s.local[STORAGE_KEYS.KDF_METHOD]).toBe('passphrase')
  })

  it('refuses rather than guessing when PRF is absent and no passphrase given', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubCreate(false)

    await expect(setupPasskey()).rejects.toThrow(/PRF_REQUIRES_PASSPHRASE/)
  })
})

/**
 * 🩸 The defect this file was written for.
 *
 * The credential ID is persisted IMMEDIATELY on creation, before PRF support is
 * known, so a cancelled or interrupted first attempt leaves one behind. The old
 * code then treated "a credential exists AND a passphrase was supplied" as
 * proof that PRF had already been found unsupported, and went straight to
 * passphrase KDF without ever asking the authenticator again.
 *
 * That assumption is wrong whenever the first attempt failed for any other
 * reason. On a PRF-capable device the vault would be permanently downgraded to
 * passphrase mode, and the passkey — still registered, still prompting — would
 * play no part in unlocking it.
 */
describe('setupPasskey — retry after an interrupted attempt', () => {
  it('🔒 re-probes PRF instead of assuming the passphrase is required', async () => {
    const s = storage({
      [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: 'AQIDBA',
      [STORAGE_KEYS.PRF_SALT]: 'AQIDBA',
    })
    vi.stubGlobal('chrome', s.chrome)
    const get = stubGet(true) // this device CAN do PRF

    const result = await setupPasskey('a-passphrase-the-user-typed')

    // The authenticator was consulted...
    expect(get).toHaveBeenCalled()
    // ...and PRF won, despite a passphrase being available.
    expect(result.method).toBe('prf')
    expect(s.local[STORAGE_KEYS.KDF_METHOD]).toBe('prf')
  })

  it('still falls back to the passphrase when the re-probe finds no PRF', async () => {
    const s = storage({
      [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: 'AQIDBA',
      [STORAGE_KEYS.PRF_SALT]: 'AQIDBA',
    })
    vi.stubGlobal('chrome', s.chrome)
    stubGet(false)

    const result = await setupPasskey('fallback-passphrase')

    expect(result.method).toBe('passphrase')
  })

  it('does not mint a second passkey on retry', async () => {
    // Re-registering would stack orphan credentials in the keychain, which is
    // why the original shortcut existed. Re-probing must not lose that.
    const s = storage({
      [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: 'AQIDBA',
      [STORAGE_KEYS.PRF_SALT]: 'AQIDBA',
    })
    vi.stubGlobal('chrome', s.chrome)
    stubGet(true)
    const create = (navigator.credentials as unknown as { create: ReturnType<typeof vi.fn> }).create

    await setupPasskey('a-passphrase')

    expect(create).not.toHaveBeenCalled()
  })
})
