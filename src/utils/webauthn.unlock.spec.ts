/**
 * `unlockWithPasskey` — the other half of the vault key. SOC-236.
 *
 * `setupPasskey` derives the key that encrypts the vault and is covered by
 * `webauthn.setup.spec.ts`. `requireUserVerification` guards signing and is
 * covered by `webauthn.spec.ts`. Between them sat the function that reproduces
 * the key on every subsequent unlock, with **zero tests across seven branches**
 * — including the two tagged errors the approval window matches on by prefix.
 *
 * ## The invariant, and why a round trip is the only honest way to assert it
 *
 * Unlock is not interesting because it returns a string. It is interesting
 * because it must return **the same key `setupPasskey` produced**, or the vault
 * does not decrypt. A test that asserts "unlock resolves to a base64 string"
 * passes with the HKDF salt, the info string, or the whole derivation swapped.
 *
 * So the PRF test runs setup and unlock against the same stubbed authenticator
 * and compares the two keys. The referent is the real `deriveAesKey` running
 * real WebCrypto on both sides, not a literal copied out of the implementation.
 *
 * ## The tag contract
 *
 * `PASSPHRASE_REQUIRED` and `PRF_UNAVAILABLE` are matched by
 * `String.prototype.startsWith` in `approval/App.vue` and in the popup unlock
 * flow. Renaming one here changes which message a user sees at the moment their
 * vault will not open, and nothing in the type system connects the two halves.
 * The last test reads `App.vue`'s source and asserts every tag this module
 * throws is one that component actually handles.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORAGE_KEYS } from '@/config/app'
import { setupPasskey, unlockWithPasskey } from './webauthn'

/** Distinct from the setup spec's filler so a cross-test bleed is visible. */
const PRF_BYTES = new Uint8Array(32).fill(9).buffer
const CRED_ID = new Uint8Array([1, 2, 3, 4]).buffer

/** A chrome.storage double that keeps `local` and `session` genuinely separate. */
function storage(initial: Record<string, unknown> = {}) {
  const local: Record<string, unknown> = { ...initial }
  const session: Record<string, unknown> = {}
  const chrome = {
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
  }
  return { local, session, chrome }
}

/**
 * Stub the authenticator.
 *
 * `prf` controls whether the assertion returns a PRF secret; `assertion: null`
 * models the user dismissing the prompt, which is what a cancel looks like to
 * this code.
 */
function stubAuthenticator(opts: { prf: boolean; assertion?: null }) {
  const result = {
    rawId: CRED_ID,
    getClientExtensionResults: () => (opts.prf ? { prf: { results: { first: PRF_BYTES } } } : {}),
  }
  const get = vi.fn(async () => (opts.assertion === null ? null : result))
  const create = vi.fn(async () => result)
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: { create, get },
  })
  return { get, create }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * The derivation, written from its documented contract rather than by calling
 * the code under test.
 *
 * `deriveAesKey` says: HKDF-SHA256 over the PRF secret, salted with the stored
 * PRF salt, info `attestto-id-vault-key`, producing a 256-bit AES-GCM key
 * exported as base64. This re-derives that independently.
 *
 * It exists because the round-trip test below is NOT sufficient on its own. A
 * change to the info string, the hash, or the key length alters setup and
 * unlock symmetrically — they keep agreeing with each other while every vault
 * encrypted by the previous version becomes permanently undecryptable. Proven:
 * with `HKDF_INFO` edited, all ten tests still passed until this was added.
 */
async function expectedVaultKey(prfSecret: ArrayBuffer, salt: ArrayBuffer): Promise<string> {
  const material = await crypto.subtle.importKey('raw', prfSecret, 'HKDF', false, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info: new TextEncoder().encode('attestto-id-vault-key'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  const raw = await crypto.subtle.exportKey('raw', aes)
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
}

/** base64url -> ArrayBuffer, for reading back the salt the setup path stored. */
function fromBase64Url(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

describe('unlockWithPasskey — PRF', () => {
  it('derives the key the contract specifies, not merely one setup agrees with', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: true })
    await setupPasskey()

    const unlocked = await unlockWithPasskey()
    const salt = fromBase64Url(s.local[STORAGE_KEYS.PRF_SALT] as string)

    expect(
      unlocked,
      'the vault key is no longer HKDF-SHA256(prf, salt, "attestto-id-vault-key") — ' +
        'every vault encrypted by the previous derivation is now undecryptable',
    ).toBe(await expectedVaultKey(PRF_BYTES, salt))
  })

  it('reproduces the exact key setupPasskey derived', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: true })

    const setup = await setupPasskey()
    const unlocked = await unlockWithPasskey()

    expect(setup.aesKeyBase64, 'setup did not take the PRF path').toBeTruthy()
    expect(
      unlocked,
      'unlock derived a different key from setup — the vault encrypted at setup ' +
        'would not decrypt, and every later unlock would look like data corruption',
    ).toBe(setup.aesKeyBase64)
  })

  it('caches the derived key in session storage, not local', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: true })

    const key = await unlockWithPasskey().catch(() => null)
    // No credential registered yet, so this first call must fail rather than
    // silently derive from nothing.
    expect(key).toBeNull()

    await setupPasskey()
    const unlocked = await unlockWithPasskey()

    expect(s.session[STORAGE_KEYS.SESSION_KEY]).toBe(unlocked)
    expect(
      s.local[STORAGE_KEYS.SESSION_KEY],
      'the session key was written to local storage, where it survives browser restart',
    ).toBeUndefined()
  })

  it('refuses when no credential or salt is stored', async () => {
    vi.stubGlobal('chrome', storage({ [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: 'Zm9v' }).chrome)
    stubAuthenticator({ prf: true })

    // Credential id present, PRF salt absent — a half-written setup. Deriving
    // from a default salt here would produce a key that decrypts nothing.
    await expect(unlockWithPasskey()).rejects.toThrow(/No passkey registered/)
  })

  it('refuses when the user dismisses the prompt', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: true })
    await setupPasskey()

    // Setup legitimately caches a key (it unlocks the vault it just created).
    // Clear it so the assertion below is about what the CANCEL did, not about
    // what setup left behind — otherwise this passes for the wrong reason.
    delete s.session[STORAGE_KEYS.SESSION_KEY]

    stubAuthenticator({ prf: true, assertion: null })
    await expect(unlockWithPasskey()).rejects.toThrow(/cancelled/)
    expect(
      s.session[STORAGE_KEYS.SESSION_KEY],
      'a cancelled unlock still cached a key',
    ).toBeUndefined()
  })

  it('tags PRF_UNAVAILABLE when the authenticator stops returning a PRF secret', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: true })
    await setupPasskey()

    // Same vault, same credential, but the authenticator no longer produces a
    // PRF result. There is no safe fallback: deriving any other way yields a
    // key that cannot decrypt this vault, so it must fail loudly.
    stubAuthenticator({ prf: false })
    await expect(unlockWithPasskey()).rejects.toThrow(/^PRF_UNAVAILABLE:/)
  })
})

/**
 * Argon2id at 19 MiB and t=2 is deliberately expensive, and each round-trip
 * below pays for it twice (once in setup, once in unlock). In isolation that is
 * ~400 ms; inside the full suite, sharing cores with 96 other files, it went
 * past the 5 s default and failed as a timeout.
 *
 * The budget is stated explicitly rather than left to the default, because a
 * test that races the clock under load is a flake, and a flaky test on the
 * vault-key path is worse than no test: it trains people to re-run rather than
 * read. `passphrase-kdf.spec.ts` needs no such allowance because each of its
 * cases derives exactly once.
 */
const ARGON2_ROUND_TRIP_MS = 30_000

describe('unlockWithPasskey — passphrase', () => {
  it('tags PASSPHRASE_REQUIRED rather than prompting for a passkey', async () => {
    vi.stubGlobal('chrome', storage({ [STORAGE_KEYS.KDF_METHOD]: 'passphrase' }).chrome)
    const auth = stubAuthenticator({ prf: true })

    await expect(unlockWithPasskey()).rejects.toThrow(/^PASSPHRASE_REQUIRED:/)
    expect(
      auth.get,
      'a passphrase vault triggered a WebAuthn prompt — the passkey cannot open it, ' +
        'so the prompt can only confuse',
    ).not.toHaveBeenCalled()
  })

  it('derives from the passphrase and caches the result', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    // PRF absent at setup forces the passphrase branch, which also writes the
    // salt this unlock has to read back.
    stubAuthenticator({ prf: false })
    const setup = await setupPasskey('correct horse battery staple')

    const unlocked = await unlockWithPasskey('correct horse battery staple')

    expect(unlocked).toBe(setup.aesKeyBase64)
    expect(s.session[STORAGE_KEYS.SESSION_KEY]).toBe(unlocked)
  }, ARGON2_ROUND_TRIP_MS)

  it('derives a different key from a different passphrase', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: false })
    const setup = await setupPasskey('correct horse battery staple')

    // Control case. Without it, a derivation that ignored its input entirely
    // would satisfy the round-trip test above.
    const wrong = await unlockWithPasskey('Tr0ub4dor&3')
    expect(wrong).not.toBe(setup.aesKeyBase64)
  }, ARGON2_ROUND_TRIP_MS)

  it('treats a vault with no recorded method as PRF, not passphrase', async () => {
    const s = storage()
    vi.stubGlobal('chrome', s.chrome)
    stubAuthenticator({ prf: true })
    await setupPasskey()
    // Legacy vaults predate the KDF marker. Reading the absent marker as
    // 'passphrase' would ask for a passphrase that was never set.
    delete s.local[STORAGE_KEYS.KDF_METHOD]

    await expect(unlockWithPasskey()).resolves.toBeTruthy()
  })
})

describe('the tagged errors are a contract with the consent UI', () => {
  /**
   * Both halves are read from source. Asserting against a list written in this
   * file would restate the implementation and agree with it forever, which is
   * the failure mode this repo keeps finding.
   */
  // Resolved from the package root, not `import.meta.url`: under Vite's
  // transform that is not a `file:` URL and `fileURLToPath` throws.
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
  const webauthnSource = read('src/utils/webauthn.ts')
  const approvalSource = read('src/entrypoints/approval/App.vue')

  it('every tag this module throws is handled by the approval window', () => {
    // `throw new Error('SCREAMING_TAG: …')` — the convention for an error whose
    // identity a caller branches on, as opposed to a message it only displays.
    const thrown = [
      ...webauthnSource.matchAll(/throw new Error\(\s*\n?\s*'([A-Z][A-Z_]{4,}):/g),
    ].map((m) => m[1])

    expect(thrown.length, 'no tagged errors found — the regex stopped matching').toBeGreaterThan(2)

    const handled = [...approvalSource.matchAll(/startsWith\('([A-Z][A-Z_]{4,})'\)/g)].map((m) => m[1])
    const unhandled = [...new Set(thrown)].filter((tag) => !handled.includes(tag))

    expect(
      unhandled,
      `These tagged errors reach the approval window and fall through to the raw-message\n` +
        `branch, so the user sees implementation text at the moment their vault will not\n` +
        `open. Either handle the tag in approval/App.vue or stop tagging the error.`,
    ).toEqual([])
  })
})
