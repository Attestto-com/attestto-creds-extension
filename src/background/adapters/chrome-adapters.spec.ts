/**
 * Story 1.13 Phase 11 — the KeyAdmin and untrusted adapters.
 *
 * Thin adapters, but two things here are worth a real assertion rather than a
 * delegation check:
 *
 *   - `generateP256` must export a public JWK with NO private component. It is
 *     the material a handler mirrors to the unencrypted public vault, so a `d`
 *     riding along is a private key written to disk in the clear. This runs real
 *     WebCrypto, not a stub — a mocked `subtle` would prove nothing about what
 *     the browser actually hands back.
 *   - the store's three methods must map to the three DIFFERENT vault utilities.
 *     Wiring `syncPublic` to `write` (or vice versa) is a plausible slip and a
 *     catastrophic one, and it type-checks: all three take a `VaultData` and
 *     return `Promise<void>`. The test distinguishes them by identity.
 */
import { describe, it, expect, vi } from 'vitest'
import { createKeyAdminAdapters, createUntrustedAdapters } from './chrome-adapters'
import type { VaultData } from '@/stores/wallet'

function vaultUtilsSpy() {
  const calls: { method: string; vault?: VaultData }[] = []
  return {
    calls,
    utils: {
      readVault: async () => {
        calls.push({ method: 'readVault' })
        return null
      },
      writeVault: async (vault: VaultData) => {
        calls.push({ method: 'writeVault', vault })
      },
      syncPublicVault: async (vault: VaultData) => {
        calls.push({ method: 'syncPublicVault', vault })
      },
    },
  }
}

const someVault = { did: 'did:jwk:x' } as VaultData

describe('createKeyAdminAdapters — store', () => {
  it('maps each store method to its OWN vault utility', async () => {
    const { utils, calls } = vaultUtilsSpy()
    const { store } = createKeyAdminAdapters(utils)

    await store.read()
    await store.write(someVault)
    await store.syncPublic(someVault)

    expect(calls.map((c) => c.method)).toEqual(['readVault', 'writeVault', 'syncPublicVault'])
  })

  it('passes the vault through to write and to the public mirror unchanged', async () => {
    const { utils, calls } = vaultUtilsSpy()
    const { store } = createKeyAdminAdapters(utils)

    await store.write(someVault)
    await store.syncPublic(someVault)

    expect(calls[0].vault).toBe(someVault)
    expect(calls[1].vault).toBe(someVault)
  })

  it('surfaces a locked vault as null rather than throwing', async () => {
    const { utils } = vaultUtilsSpy()
    expect(await createKeyAdminAdapters(utils).store.read()).toBeNull()
  })
})

describe('createKeyAdminAdapters — generateP256 (real WebCrypto)', () => {
  it('exports a public JWK with NO private component', async () => {
    const { keygen } = createKeyAdminAdapters(vaultUtilsSpy().utils)
    const { publicKeyJwk, privateKeyJwk } = await keygen.generateP256()

    // `d` is the private scalar. It must exist on one side and not the other.
    expect(privateKeyJwk.d).toBeTruthy()
    expect(publicKeyJwk.d).toBeUndefined()
    expect(JSON.stringify(publicKeyJwk)).not.toContain(privateKeyJwk.d as string)
  })

  it('produces a usable P-256 key pair, not an opaque blob', async () => {
    const { keygen } = createKeyAdminAdapters(vaultUtilsSpy().utils)
    const { publicKeyJwk, privateKeyJwk } = await keygen.generateP256()

    expect(publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(privateKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    // Both halves describe the same point.
    expect(publicKeyJwk.x).toBe(privateKeyJwk.x)
    expect(publicKeyJwk.y).toBe(privateKeyJwk.y)
  })

  it('generates a DIFFERENT key each call — rotation must not reissue the old key', async () => {
    const { keygen } = createKeyAdminAdapters(vaultUtilsSpy().utils)
    const first = await keygen.generateP256()
    const second = await keygen.generateP256()
    expect(second.publicKeyJwk.x).not.toBe(first.publicKeyJwk.x)
    expect(second.privateKeyJwk.d).not.toBe(first.privateKeyJwk.d)
  })

  it('is a key SOURCE and not a sign path — the adapter exposes no signing method', () => {
    const { keygen } = createKeyAdminAdapters(vaultUtilsSpy().utils)
    expect(Object.keys(keygen)).toEqual(['generateP256'])
  })
})

describe('createUntrustedAdapters', () => {
  it('creates an OS notification under the id it was given', async () => {
    const create = vi.fn()
    ;(globalThis as Record<string, unknown>).chrome = {
      notifications: { create },
      runtime: { sendMessage: vi.fn(), getURL: (p: string) => `chrome-extension://t/${p}` },
    }

    const options = { type: 'basic', iconUrl: 'i', title: 't', message: 'm' }
    await createUntrustedAdapters().notifications.create('didcomm-1', options)

    expect(create).toHaveBeenCalledWith('didcomm-1', options)
  })

  it('broadcasts to the popup and resolves packaged URLs', async () => {
    const sendMessage = vi.fn()
    ;(globalThis as Record<string, unknown>).chrome = {
      notifications: { create: vi.fn() },
      runtime: { sendMessage, getURL: (p: string) => `chrome-extension://t/${p}` },
    }

    const adapters = createUntrustedAdapters()
    await adapters.runtime.sendMessage({ type: 'DIDCOMM_PROOF_REQUEST' })

    expect(sendMessage).toHaveBeenCalledWith({ type: 'DIDCOMM_PROOF_REQUEST' })
    expect(adapters.runtime.getURL('icon/48.png')).toBe('chrome-extension://t/icon/48.png')
  })

  it('exposes NO vault, key or signing capability — a handler given this cannot name one', () => {
    const adapters = createUntrustedAdapters()
    expect(Object.keys(adapters).sort()).toEqual(['notifications', 'runtime'])
    expect(JSON.stringify(Object.keys(adapters))).not.toMatch(/vault|crypto|sign|key/i)
  })
})
