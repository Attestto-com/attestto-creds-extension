import { describe, it, expect, vi, afterEach } from 'vitest'
import { STORAGE_KEYS } from '@/config/app'
import { requireUserVerification } from './webauthn'

// A base64url-encoded stand-in for a stored WebAuthn credential id.
const CRED_ID = 'Zm9vYmFy'

function stubChromeWithCred(credId: string | undefined): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () =>
          credId !== undefined ? { [STORAGE_KEYS.WEBAUTHN_CREDENTIAL_ID]: credId } : {},
        ),
      },
    },
  })
}

function stubCredentialsGet(impl: () => unknown): ReturnType<typeof vi.fn> {
  const get = vi.fn(impl)
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: { get },
  })
  return get
}

describe('requireUserVerification (ATT-1098 signing gate)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis.navigator, 'credentials')
  })

  it('throws USER_VERIFICATION_UNAVAILABLE when no passkey is registered', async () => {
    stubChromeWithCred(undefined)
    await expect(requireUserVerification()).rejects.toThrow('USER_VERIFICATION_UNAVAILABLE')
  })

  it('asserts with userVerification required over the registered credential', async () => {
    stubChromeWithCred(CRED_ID)
    const get = stubCredentialsGet(async () => ({ id: 'ok' }))

    await expect(requireUserVerification()).resolves.toBeUndefined()

    const opts = get.mock.calls[0][0] as { publicKey: PublicKeyCredentialRequestOptions }
    expect(opts.publicKey.userVerification).toBe('required')
    expect(opts.publicKey.allowCredentials).toHaveLength(1)
    expect(opts.publicKey.challenge).toBeInstanceOf(Uint8Array)
  })

  it('throws USER_VERIFICATION_CANCELLED (fail-closed) when the assertion is null', async () => {
    stubChromeWithCred(CRED_ID)
    stubCredentialsGet(async () => null)
    await expect(requireUserVerification()).rejects.toThrow('USER_VERIFICATION_CANCELLED')
  })

  it('propagates an authenticator NotAllowedError (fail-closed, no signature)', async () => {
    stubChromeWithCred(CRED_ID)
    stubCredentialsGet(async () => {
      throw new DOMException('The operation was cancelled', 'NotAllowedError')
    })
    await expect(requireUserVerification()).rejects.toThrow()
  })
})
