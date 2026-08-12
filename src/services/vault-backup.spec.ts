import { describe, it, expect } from 'vitest'
import type { VaultData, LinkedIdentity } from '@/stores/wallet'
import {
  exportPassphraseBackup,
  importPassphraseBackup,
  exportShamirBackup,
  importShamirBackup,
  detectBackupMethod,
} from './vault-backup'

const FIXED = () => new Date('2026-07-19T00:00:00.000Z')

/** A representative vault, including private key material we must not lose. */
function makeVault(): VaultData {
  return {
    did: 'did:jwk:eyJrdHkiOiJFQyJ9',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'secret-d', x: 'xx', y: 'yy' },
    ed25519PublicKeyB64: 'AAAAAAAA',
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    // Cast: only asserting round-trip fidelity, not the full identity shape.
    linkedIdentities: [{ did: 'did:sns:chongkan.attestto.sol' } as unknown as LinkedIdentity],
  }
}

/**
 * Every test in this block runs Argon2id twice (export then import), at the
 * deliberately memory-hard OWASP parameters — ~380 ms a derivation here, and
 * slower on a CI runner with fewer cores than a dev machine. Under vitest's
 * default 5 s they pass alone and fail intermittently in a full run.
 *
 * Raise the timeout, never lower the KDF cost: the cost is the security
 * property. See the note in `src/utils/passphrase-kdf.spec.ts`.
 */
describe('vault-backup — passphrase method', { timeout: 30_000 }, () => {
  it('round-trips the full vault including private key material', async () => {
    const vault = makeVault()
    const file = await exportPassphraseBackup(vault, 'correct horse battery staple', FIXED)
    const restored = await importPassphraseBackup(file, 'correct horse battery staple')
    expect(restored).toEqual(vault)
  })

  it('reports its method for the recovery UI', async () => {
    const file = await exportPassphraseBackup(makeVault(), 'a valid passphrase', FIXED)
    expect(detectBackupMethod(file)).toBe('passphrase')
  })

  it('rejects a wrong passphrase', async () => {
    const file = await exportPassphraseBackup(makeVault(), 'the right passphrase', FIXED)
    await expect(importPassphraseBackup(file, 'the wrong passphrase')).rejects.toThrow(
      /wrong passphrase or corrupted/i,
    )
  })

  it('enforces the KDF minimum passphrase length', async () => {
    await expect(exportPassphraseBackup(makeVault(), 'short', FIXED)).rejects.toThrow(
      /at least 8 characters/i,
    )
  })
})

describe('vault-backup — shamir 2-of-3 method', () => {
  it('restores from any 2 of the 3 shares', async () => {
    const vault = makeVault()
    const { file, shares } = await exportShamirBackup(vault, FIXED)
    expect(shares).toHaveLength(3)

    const pairs: [number, number][] = [
      [0, 1],
      [0, 2],
      [1, 2],
    ]
    for (const [i, j] of pairs) {
      const restored = await importShamirBackup(file, shares[i], shares[j])
      expect(restored).toEqual(vault)
    }
  })

  it('the file alone carries no usable share (method is shamir)', async () => {
    const { file } = await exportShamirBackup(makeVault(), FIXED)
    expect(detectBackupMethod(file)).toBe('shamir-2of3')
  })

  it('rejects two identical shares', async () => {
    const { file, shares } = await exportShamirBackup(makeVault(), FIXED)
    await expect(importShamirBackup(file, shares[0], shares[0])).rejects.toThrow(/identical/i)
  })

  it('rejects a malformed share', async () => {
    const { file } = await exportShamirBackup(makeVault(), FIXED)
    await expect(importShamirBackup(file, 'not-a-share', '2.AAAA')).rejects.toThrow(/share/i)
  })
})

describe('vault-backup — file validation', () => {
  it('rejects non-JSON input', () => {
    expect(() => detectBackupMethod('}{ not json')).toThrow(/invalid JSON/i)
  })

  it('rejects a JSON file that is not an Attestto backup', () => {
    expect(() => detectBackupMethod(JSON.stringify({ hello: 'world' }))).toThrow(/Attestto vault backup/i)
  })

  it('refuses to open a passphrase file as a shamir restore', async () => {
    const file = await exportPassphraseBackup(makeVault(), 'a valid passphrase', FIXED)
    await expect(importShamirBackup(file, '1.AAAA', '2.BBBB')).rejects.toThrow(/passphrase.*not.*shamir/i)
  })
})
