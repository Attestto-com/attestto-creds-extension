/**
 * Story 1.11 — characterization of `handlePaymentApprove`, transcribed from the
 * legacy switch (`background.ts:2096-2168`) FIRST; the extracted handler passes it
 * unchanged. Same non-vacuity harness as the SIGN_DOCUMENT twin: the ctx's
 * `crypto.sign` is the REAL `createGatedSign` with a `rawSign` SPY + toggleable gate.
 *
 * The family's distinctive referent: the SIGNED amount is byte-identical to the
 * consented amount in the backend's 2-decimal form (`amount.toFixed(2)`) — a
 * re-format ("10" / "10.0" / "10.5") reddens the cross-tie. This is the control
 * that stops a silent value-drift between what the user approved and what was
 * signed.
 */
import { describe, it, expect, vi } from 'vitest'
import { handlePaymentApprove } from './payment-approve.handler'
import { createGatedSign, type PresenceGate } from '@/background/crypto/gated-sign'
import type { VaultData } from '@/stores/wallet'

const SENTINEL = new Uint8Array([0x11, 0x22, 0x33])
const SENTINEL_B64 = btoa(String.fromCharCode(...SENTINEL))
const UUID = 'pay-uuid-9'

function makeVault(overrides: Partial<VaultData> = {}): VaultData {
  return {
    did: 'did:jwk:root',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'PUB_X', y: 'PUB_Y', d: 'ROOT_SECRET' } as JsonWebKey,
    holderDid: undefined,
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
  const rawSign = vi.fn(async (_payload: Uint8Array) => ({ bytes: SENTINEL }))
  const crypto = { sign: createGatedSign({ assertPresence: gate, rawSign }), deriveForOrigin: vi.fn() }
  const read = vi.fn(async () => vault)
  const ctx = { store: { read }, crypto }
  return { ctx, rawSign, read }
}

function signedText(rawSign: ReturnType<typeof vi.fn>): string {
  return new TextDecoder().decode(rawSign.mock.calls[0][0] as Uint8Array)
}

describe('handlePaymentApprove — characterization (parity-to-legacy)', () => {
  it('happy path (selectedDid): signs the canonical payment payload, returns stripped pubkey', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())
    const result = await handlePaymentApprove(
      { paymentRequestUuid: UUID, amount: 12.5, selectedDid: 'did:sns:alice.attestto.sol' },
      ctx,
    )
    expect(result).toEqual({
      ok: true,
      did: 'did:sns:alice.attestto.sol',
      signature: SENTINEL_B64,
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'PUB_X', y: 'PUB_Y' },
    })
    expect(rawSign).toHaveBeenCalledTimes(1)
  })

  it('AMOUNT REFERENT — whole number is signed as 2-decimal (catches "10" / "10.0" re-format)', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 10, selectedDid: 'did:x' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    expect(signedText(rawSign)).toBe(`attestto:pay:${UUID}:did:x:10.00`)
    expect(signedText(rawSign)).toContain(':10.00')
    expect(signedText(rawSign)).not.toContain(':10:') // not the bare integer
  })

  it('AMOUNT REFERENT — one-decimal input is padded to two (12.5 → 12.50)', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())
    await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 12.5, selectedDid: 'did:x' }, ctx)
    expect(signedText(rawSign)).toBe(`attestto:pay:${UUID}:did:x:12.50`)
  })

  it('CROSS-TIE — the signed bytes carry the same did as the response (catches sign≠return)', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 5, selectedDid: 'did:x' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    expect(signedText(rawSign)).toBe(`attestto:pay:${UUID}:${result.did}:5.00`)
  })

  it('REFERENT — emitted signature is base64 of the GATED signer output', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1, selectedDid: 'did:x' }, ctx)
    expect(result.ok && result.signature).toBe(SENTINEL_B64)
  })

  it('POSITIVE CONTROL — public-key strip: response pubkey never carries `d`', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1, selectedDid: 'did:x' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    expect('d' in result.publicKeyJwk).toBe(false)
    expect(JSON.stringify(result.publicKeyJwk)).not.toContain('ROOT_SECRET')
  })

  it('FAIL-CLOSED — gate rejects → NO signature, rawSign NEVER called', async () => {
    const gate: PresenceGate = vi.fn(async () => {
      throw new Error('USER_VERIFICATION_CANCELLED')
    })
    const { ctx, rawSign } = makeCtx(makeVault(), { gate })
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'USER_VERIFICATION_CANCELLED' })
    expect('signature' in result).toBe(false)
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('DID precedence: selectedDid absent → holderDid wins over did', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: 'did:holder', did: 'did:jwk:root' }))
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1 }, ctx)
    expect(result.ok && result.did).toBe('did:holder')
  })

  it('no DID anywhere → "No DID configured", rawSign not called', async () => {
    const { ctx, rawSign } = makeCtx(makeVault({ holderDid: undefined, did: undefined }))
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1 }, ctx)
    expect(result).toEqual({ ok: false, error: 'No DID configured' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('vault locked (read → null) → "Vault not ready", rawSign not called', async () => {
    const { ctx, rawSign } = makeCtx(null)
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('vault present but no privateKeyJwk → "Vault not ready", rawSign not called', async () => {
    const { ctx, rawSign } = makeCtx(makeVault({ privateKeyJwk: null }))
    const result = await handlePaymentApprove({ paymentRequestUuid: UUID, amount: 1, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
    expect(rawSign).not.toHaveBeenCalled()
  })
})
