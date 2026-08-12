/**
 * Story 1.13 Phase 10 — the vault-record writers.
 *
 * Two invariants carry the weight and neither is visible from a return value,
 * so the store records an ordered effect log and the assertions read it:
 *
 *   - every `write` is followed by `syncPublic` (the dual-vault rule from the
 *     repo CLAUDE.md — break it and the popup never sees the change);
 *   - a locked vault produces NO write at all, and says so.
 *
 * The third group is about trust in the payload: records are built field by
 * field, so a requester cannot deliver a proof request that is already approved
 * or a presentation already marked spent. Those tests feed hostile payloads and
 * assert on the stored artefact.
 */
import { describe, it, expect } from 'vitest'
import {
  recordProofAccessRequest,
  recordPreparedPresentation,
  linkWalletAddress,
  type VaultRecordCtx,
} from './vault-records.handler'
import type { VaultData } from '@/stores/wallet'
import type { ProofAccessRequestMessage, PushPresentationMessage } from '@/utils/messaging'

const NOW = '2026-08-08T12:00:00.000Z'

function emptyVault(): VaultData {
  return {
    did: null,
    privateKeyJwk: null,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
  }
}

function harness(vault: VaultData | null = emptyVault()) {
  const log: string[] = []
  const written: VaultData[] = []
  const ctx: VaultRecordCtx = {
    store: {
      read: async () => {
        log.push('read')
        return vault
      },
      write: async (v) => {
        log.push('write')
        written.push(structuredClone(v))
      },
      syncPublic: async () => {
        log.push('syncPublic')
      },
    },
    clock: { nowIso: () => NOW },
    newId: (prefix) => `${prefix}-fixed`,
  }
  return { ctx, log, written, vault }
}

const proofPayload = (extra: Record<string, unknown> = {}) =>
  ({
    credentialId: 'cred-1',
    requesterDid: 'did:web:verifier.cr',
    requesterName: 'Verifier',
    purpose: 'Employment check',
    requestedFields: ['nombre', 'cargo'],
    expiresAt: '2026-09-09T00:00:00Z',
    transport: 'didcomm',
    nonce: 'n-1',
    audience: 'https://verifier.cr',
    ...extra,
  }) as unknown as ProofAccessRequestMessage['payload']

const pushPayload = (extra: Record<string, unknown> = {}) =>
  ({
    credentialId: 'cred-1',
    presentation: { vp: true },
    selectedFields: ['nombre'],
    expiresAt: '2026-09-09T00:00:00Z',
    ...extra,
  }) as unknown as PushPresentationMessage['payload']

describe('the dual-vault rule: write is always followed by syncPublic', () => {
  it('holds for a proof-access request', async () => {
    const h = harness()
    await recordProofAccessRequest(proofPayload(), h.ctx)
    expect(h.log).toEqual(['read', 'write', 'syncPublic'])
  })

  it('holds for a prepared presentation', async () => {
    const h = harness()
    await recordPreparedPresentation(pushPayload(), h.ctx)
    expect(h.log).toEqual(['read', 'write', 'syncPublic'])
  })

  it('holds for a wallet link', async () => {
    const h = harness()
    await linkWalletAddress('So1anaAddr', h.ctx)
    expect(h.log).toEqual(['read', 'write', 'syncPublic'])
  })
})

describe('a locked vault stores nothing and says so', () => {
  it('writes nothing for a proof-access request, and reports stored=false', async () => {
    const h = harness(null)
    const out = await recordProofAccessRequest(proofPayload(), h.ctx)
    expect(out.stored).toBe(false)
    expect(h.log).toEqual(['read'])
    expect(h.written).toEqual([])
  })

  it('still mints the record so the caller has an id to correlate with', async () => {
    const h = harness(null)
    const out = await recordProofAccessRequest(proofPayload(), h.ctx)
    expect(out.record.id).toBe('par-fixed')
  })

  it('writes nothing for a prepared presentation, and reports stored=false', async () => {
    const h = harness(null)
    const out = await recordPreparedPresentation(pushPayload(), h.ctx)
    expect(out.stored).toBe(false)
    expect(h.log).toEqual(['read'])
  })

  it('writes nothing for a wallet link, and reports stored=false rather than an error', async () => {
    const h = harness(null)
    expect(await linkWalletAddress('So1anaAddr', h.ctx)).toEqual({ ok: true, stored: false })
    expect(h.log).toEqual(['read'])
  })
})

describe('the payload cannot pre-decide its own record', () => {
  it('a proof request arrives PENDING with nothing approved, whatever the sender claimed', async () => {
    const h = harness()
    const out = await recordProofAccessRequest(
      proofPayload({ status: 'approved', approvedFields: ['cedula', 'salario'], decidedAt: NOW }),
      h.ctx,
    )
    expect(out.record.status).toBe('pending')
    expect(out.record.approvedFields).toEqual([])
    expect(out.record.decidedAt).toBeNull()

    const stored = h.written[0].proofRequests[0]
    expect(stored.status).toBe('pending')
    expect(stored.approvedFields).toEqual([])
    expect(JSON.stringify(stored)).not.toContain('salario')
  })

  it('a pushed presentation arrives UNUSED, whatever the sender claimed', async () => {
    const h = harness()
    const out = await recordPreparedPresentation(pushPayload({ used: true, usedAt: NOW }), h.ctx)
    expect(out.record.used).toBe(false)
    expect(out.record.usedAt).toBeNull()
    expect(h.written[0].preparedPresentations[0]).toMatchObject({ used: false, usedAt: null })
  })

  it('an id supplied by the sender is not honoured', async () => {
    const h = harness()
    const out = await recordProofAccessRequest(proofPayload({ id: 'attacker-chosen' }), h.ctx)
    expect(out.record.id).toBe('par-fixed')
    expect(h.written[0].proofRequests[0].id).toBe('par-fixed')
  })

  it('a received-at timestamp comes from the clock, not the sender', async () => {
    const h = harness()
    const out = await recordProofAccessRequest(proofPayload({ receivedAt: '1999-01-01T00:00:00Z' }), h.ctx)
    expect(out.record.receivedAt).toBe(NOW)
  })
})

describe('records append rather than replace', () => {
  it('keeps existing proof requests', async () => {
    const vault = emptyVault()
    vault.proofRequests = [{ id: 'older' } as never]
    const h = harness(vault)
    await recordProofAccessRequest(proofPayload(), h.ctx)
    expect(h.written[0].proofRequests.map((r) => r.id)).toEqual(['older', 'par-fixed'])
  })

  it('keeps existing prepared presentations', async () => {
    const vault = emptyVault()
    vault.preparedPresentations = [{ id: 'older' } as never]
    const h = harness(vault)
    await recordPreparedPresentation(pushPayload(), h.ctx)
    expect(h.written[0].preparedPresentations.map((p) => p.id)).toEqual(['older', 'prep-fixed'])
  })

  it('survives a vault whose record arrays were never initialised', async () => {
    const vault = emptyVault()
    vault.proofRequests = undefined as never
    const h = harness(vault)
    const out = await recordProofAccessRequest(proofPayload(), h.ctx)
    expect(out.stored).toBe(true)
    expect(h.written[0].proofRequests).toHaveLength(1)
  })
})

describe('linkWalletAddress', () => {
  it('stores the address and mirrors it', async () => {
    const h = harness()
    expect(await linkWalletAddress('So1anaAddr', h.ctx)).toEqual({ ok: true, stored: true })
    expect(h.written[0].linkedSolanaAddress).toBe('So1anaAddr')
  })

  it('replaces a previously linked address rather than accumulating', async () => {
    const vault = emptyVault()
    vault.linkedSolanaAddress = 'OldAddr'
    const h = harness(vault)
    await linkWalletAddress('NewAddr', h.ctx)
    expect(h.written[0].linkedSolanaAddress).toBe('NewAddr')
  })

  it('rejects a missing address without reading or writing the vault', async () => {
    const h = harness()
    expect(await linkWalletAddress(undefined, h.ctx)).toEqual({ ok: false, error: 'No address provided' })
    expect(h.log).toEqual([])
  })

  it('rejects an empty address the same way', async () => {
    const h = harness()
    expect(await linkWalletAddress('', h.ctx)).toEqual({ ok: false, error: 'No address provided' })
    expect(h.log).toEqual([])
  })
})
