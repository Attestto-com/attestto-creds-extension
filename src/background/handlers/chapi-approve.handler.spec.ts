/**
 * Story 1.11 — characterization of `handleChapiApprove`, transcribed from the legacy
 * switch (`background.ts:2186-2247`). The signing harness is the same as the other
 * families: ctx's `crypto.sign` is the REAL `createGatedSign` with a `rawSign` SPY +
 * toggleable gate — so the VP's `proof.jws` signature must equal the injected
 * signer's sentinel output, proving the presentation was signed through the gate and
 * not some hidden path.
 *
 * CHAPI-specific referents: only json-ld credentials enter the VP; the holderDid
 * fallback chain (holderDid → did → did:pkh:solana); challenge/domain fallbacks;
 * and fail-closed (a rejecting gate yields NO presentation).
 */
import { describe, it, expect, vi } from 'vitest'
import { handleChapiApprove } from './chapi-approve.handler'
import { createGatedSign, type PresenceGate } from '@/background/crypto/gated-sign'
import { base64urlBytes } from '@/services/jws'
import type { VaultData } from '@/stores/wallet'
import type { StoredCredential } from '@/types/credential'

const SENTINEL = new Uint8Array([0xca, 0xfe, 0xba, 0xbe])
const SENTINEL_SIG = base64urlBytes(SENTINEL)

function jsonLdCred(id: string, issuer: string): StoredCredential {
  return {
    id,
    format: 'json-ld',
    raw: JSON.stringify({ type: ['VerifiableCredential'], issuer }),
    issuer,
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    types: ['VerifiableCredential'],
    decodedClaims: {},
    metadata: { addedAt: '2026-01-01T00:00:00Z', source: 'manual' },
  }
}
function sdJwtCred(id: string): StoredCredential {
  return { ...jsonLdCred(id, 'did:issuer:sd'), format: 'sd-jwt', raw: 'header~disc~' }
}

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:root',
    holderDid: 'did:sns:alice.attestto.sol',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', d: 'ROOT_SECRET' },
    verificationMethod: 'did:sns:alice.attestto.sol#solana-key',
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    linkedIdentities: [],
    ...overrides,
  }
}

function makeCtx(vault: VaultData | null, opts: { gate?: PresenceGate } = {}) {
  const gate: PresenceGate = opts.gate ?? (async () => {})
  const rawSign = vi.fn(async (_p: Uint8Array) => ({ bytes: SENTINEL }))
  const crypto = { sign: createGatedSign({ assertPresence: gate, rawSign }), deriveForOrigin: vi.fn() }
  const ctx = { store: { read: vi.fn(async () => vault) }, crypto }
  return { ctx, rawSign }
}

const input = { challenge: 'chal-1', nonce: 'nonce-1', domain: 'https://verifier.example', origin: 'https://site.example' }

describe('handleChapiApprove — characterization (parity-to-legacy)', () => {
  it('happy path: builds a VP signed through the gate, returns holderDid + presentation', async () => {
    const { ctx } = makeCtx(makeVault({ credentials: [jsonLdCred('c1', 'did:issuer:1')] }))
    const result = await handleChapiApprove(input, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.holderDid).toBe('did:sns:alice.attestto.sol')
    const proof = result.presentation.proof as Record<string, unknown>
    // REFERENT: the VP signature is the injected gated signer's output
    expect((proof.jws as string).split('.')[2]).toBe(SENTINEL_SIG)
  })

  it('CREDENTIAL FILTER — only json-ld credentials enter the VP (sd-jwt excluded)', async () => {
    const { ctx } = makeCtx(
      makeVault({ credentials: [jsonLdCred('c1', 'did:issuer:1'), sdJwtCred('c2'), jsonLdCred('c3', 'did:issuer:3')] }),
    )
    const result = await handleChapiApprove(input, ctx)
    if (!result.ok) throw new Error('expected ok')
    const vcs = result.presentation.verifiableCredential as Array<Record<string, unknown>>
    expect(vcs).toHaveLength(2)
    expect(vcs.map((v) => v.issuer)).toEqual(['did:issuer:1', 'did:issuer:3'])
  })

  it('challenge/domain fallbacks: null challenge → nonce, null domain → origin', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleChapiApprove({ challenge: null, nonce: 'the-nonce', domain: null, origin: 'https://o.example' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    const proof = result.presentation.proof as Record<string, unknown>
    expect(proof.challenge).toBe('the-nonce')
    expect(proof.domain).toBe('https://o.example')
  })

  it('holderDid fallback: holderDid absent → vault.did', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: undefined, did: 'did:jwk:root', verificationMethod: 'did:jwk:root#0' }))
    const result = await handleChapiApprove(input, ctx)
    expect(result.ok && result.holderDid).toBe('did:jwk:root')
  })

  it('holderDid fallback: holderDid + did absent → did:pkh:solana', async () => {
    const { ctx } = makeCtx(makeVault({
      holderDid: undefined,
      did: undefined,
      linkedSolanaAddress: 'SoLaNaAddr',
      verificationMethod: 'did:pkh:solana:SoLaNaAddr#blockchainAccountId',
    }))
    const result = await handleChapiApprove(input, ctx)
    expect(result.ok && result.holderDid).toBe('did:pkh:solana:SoLaNaAddr')
  })

  it('no DID anywhere → "No DID configured"', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: undefined, did: undefined, linkedSolanaAddress: null }))
    const result = await handleChapiApprove(input, ctx)
    expect(result).toEqual({ ok: false, error: 'No DID configured' })
  })

  it('vault locked (read → null) → "Vault not ready"', async () => {
    const { ctx } = makeCtx(null)
    const result = await handleChapiApprove(input, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
  })

  it('vault present but no privateKeyJwk → "Vault not ready"', async () => {
    const { ctx } = makeCtx(makeVault({ privateKeyJwk: null }))
    const result = await handleChapiApprove(input, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
  })

  it('FAIL-CLOSED — gate rejects → VP-build failure, NO presentation, distinct tab error', async () => {
    const gate: PresenceGate = vi.fn(async () => {
      throw new Error('USER_VERIFICATION_CANCELLED')
    })
    const { ctx, rawSign } = makeCtx(makeVault(), { gate })
    const result = await handleChapiApprove(input, ctx)
    expect(result).toEqual({ ok: false, error: 'VP build failed', tabError: 'Failed to build presentation' })
    expect('presentation' in result).toBe(false)
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('empty json-ld set still builds a VP (DIDAuthentication case)', async () => {
    const { ctx } = makeCtx(makeVault({ credentials: [sdJwtCred('only-sd')] }))
    const result = await handleChapiApprove(input, ctx)
    if (!result.ok) throw new Error('expected ok')
    expect(result.presentation.verifiableCredential).toEqual([])
  })
})
