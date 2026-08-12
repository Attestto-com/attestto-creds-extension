/**
 * SOC-144 — the split-recovery export, proven at the button.
 *
 * `exportShamirBackup` and `importShamirBackup` both shipped and are
 * round-tripped in `vault-backup.spec.ts`. `RestoreBackupPanel` — which calls
 * the import — is wired into `LockScreenView`. What never existed was a caller
 * for the EXPORT, so the lock screen asked a user for a file and two recovery
 * keys that **no part of the product could produce**. A restore form that could
 * not be satisfied.
 *
 * These tests are at the view rather than the service because the service was
 * never the problem. The gap was reachability, and only mounting the thing a
 * user clicks can show that it closed.
 *
 * The end-to-end assertion is the one that matters: what the button produces is
 * fed back through the REAL `importShamirBackup` and must return the original
 * vault. Asserting "three strings appeared" would pass for three strings of any
 * kind, including three that open nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import en from '@/i18n/locales/en'
import { importShamirBackup } from '@/services/vault-backup'
import type { VaultData } from '@/stores/wallet'

const VAULT = {
  did: 'did:jwk:root',
  holderDid: 'did:sns:alice.attestto.sol',
  privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', d: 'THE_SECRET' },
  verificationMethod: 'did:sns:alice.attestto.sol#solana-key',
  credentials: [],
  linkedSolanaAddress: null,
  keyShares: [],
  proofRequests: [],
  preparedPresentations: [],
  linkedIdentities: [
    { did: 'did:sns:alice.attestto.sol', label: 'alice', credentials: [], syncedAt: '2026-01-01T00:00:00Z' },
  ],
  siteDids: {
    'https://bank.example': {
      did: 'did:jwk:site',
      privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'S', y: 'S', d: 'SITE_SECRET' },
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: '2026-01-01T00:00:00Z',
    },
  },
} as unknown as VaultData

vi.mock('@/utils/vault', () => ({ readVault: async () => VAULT }))
vi.mock('@/stores/wallet', () => ({ useWalletStore: () => ({ unlock: vi.fn() }) }))

import BackupView from './BackupView.vue'

/** Files the view handed to the browser, in order. */
let downloads: Array<{ name: string; body: string }>

/** Captured ONCE, before any spy exists. See the note in `beforeEach`. */
const ORIGINAL_CREATE = document.createElement.bind(document)

beforeEach(() => {
  setActivePinia(createPinia())
  downloads = []

  // `downloadText` builds a blob URL and clicks an anchor. Capture the anchor
  // rather than the blob: the blob body is not readable synchronously, and the
  // click is the observable act.
  //
  // ORIGINAL_CREATE is hoisted to module scope deliberately. Binding it inside
  // this hook captures the PREVIOUS spy on the second run, and each test then
  // adds a layer — the fourth call recursed until the stack blew. A test-double
  // that grows a layer per test is a slow-motion version of the pollution this
  // repo keeps finding.
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = ORIGINAL_CREATE(tag)
    if (tag === 'a') {
      let pendingBody = ''
      vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => {
        downloads.push({ name: (el as HTMLAnchorElement).download, body: pendingBody })
      })
      Object.defineProperty(el, 'href', {
        set(v: string) {
          pendingBody = blobBodies.get(v) ?? ''
        },
        get: () => '',
        configurable: true,
      })
    }
    return el
  })

  vi.stubGlobal('URL', {
    createObjectURL: (b: Blob) => {
      const url = `blob:${blobBodies.size}`
      // `Blob.text()` is async; the view revokes immediately, so the body is
      // captured here from the parts the view passed in.
      blobBodies.set(url, (b as Blob & { __parts?: string }).__parts ?? '')
      return url
    },
    revokeObjectURL: () => {},
  })
})

const blobBodies = new Map<string, string>()

/** Record blob contents at construction — the only synchronous access there is. */
class RecordingBlob {
  __parts: string
  constructor(parts: string[]) {
    this.__parts = parts.join('')
  }
}
vi.stubGlobal('Blob', RecordingBlob)

async function mountView() {
  const wrapper = mount(BackupView, {
    global: { plugins: [createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: { en } })] },
  })
  await flushPromises()
  return wrapper
}

describe('split-recovery export', () => {
  it('produces a file and three keys that really restore the vault', async () => {
    const wrapper = await mountView()

    await (wrapper.vm as unknown as { generateShamirBackup: () => Promise<void> }).generateShamirBackup()
    await flushPromises()

    const shares = (wrapper.vm as unknown as { shares: string[] }).shares
    expect(shares, 'the export produced no recovery keys').toHaveLength(3)
    expect(downloads, 'no recovery file was offered to the user').toHaveLength(1)

    // The real import, over the real output. This is what makes the test about
    // recovery rather than about three strings existing.
    const file = downloads[0].body
    const restored = await importShamirBackup(file, shares[0], shares[2])

    expect(restored.privateKeyJwk).toEqual(VAULT.privateKeyJwk)
    expect(
      restored.siteDids,
      'site DIDs did not survive the round trip — this recovers the whole vault ' +
        'or it is no better than the key-only path it replaced',
    ).toEqual(VAULT.siteDids)
    expect(restored.linkedIdentities).toEqual(VAULT.linkedIdentities)
  })

  it('restores from any two of the three keys', async () => {
    const wrapper = await mountView()
    await (wrapper.vm as unknown as { generateShamirBackup: () => Promise<void> }).generateShamirBackup()
    await flushPromises()

    const shares = (wrapper.vm as unknown as { shares: string[] }).shares
    const file = downloads[0].body

    // 2-of-3 is the promise the UI copy makes to the user. One pair working is
    // not that promise.
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const restored = await importShamirBackup(file, shares[a], shares[b])
      expect(restored.privateKeyJwk, `keys ${a + 1} and ${b + 1} did not restore`).toEqual(VAULT.privateKeyJwk)
    }
  })

  it('the file alone opens nothing', async () => {
    const wrapper = await mountView()
    await (wrapper.vm as unknown as { generateShamirBackup: () => Promise<void> }).generateShamirBackup()
    await flushPromises()

    const shares = (wrapper.vm as unknown as { shares: string[] }).shares
    const file = downloads[0].body

    // The copy tells the user "the file alone is useless" and that anyone with
    // two keys AND the file can open the vault. If one key sufficed, the
    // warning would be wrong in the direction that matters.
    await expect(importShamirBackup(file, shares[0], shares[0])).rejects.toThrow(/identical/i)
  })

  it('holds the keys in memory only, never in the downloaded file', async () => {
    const wrapper = await mountView()
    await (wrapper.vm as unknown as { generateShamirBackup: () => Promise<void> }).generateShamirBackup()
    await flushPromises()

    const shares = (wrapper.vm as unknown as { shares: string[] }).shares
    const file = downloads[0].body

    // A share inside the file it unlocks would collapse 2-of-3 to "hold the
    // file". This is the invariant the whole scheme rests on.
    for (const share of shares) {
      expect(file, 'a recovery key was written into the recovery file').not.toContain(share)
    }
  })
})
