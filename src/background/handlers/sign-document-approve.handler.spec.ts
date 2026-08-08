/**
 * Story 1.11 — characterization of `handleSignDocumentApprove`, transcribed from
 * the legacy switch behavior (`background.ts:1728-1799`) FIRST; the extracted
 * handler passes it unchanged (parity-to-legacy is the AC, not "it signs").
 *
 * The per-family referent that defeats the vacuous "the sign port was called"
 * trap: the ctx's `crypto.sign` is the REAL `createGatedSign`, wired with a
 * `rawSign` SPY and a TOGGLEABLE presence gate. So:
 *   - happy path → the response signature is base64 of the SPY's sentinel bytes
 *     (proves the emitted signature came from the gated path, not a raw/derived one);
 *   - rejecting gate → the handler emits NO signature and `rawSign` is NEVER called
 *     (fail-closed, the AD-11c invariant made observable);
 *   - cross-tie → the bytes `rawSign` received decode to
 *     `attestto:sign:{token}:{response.did}:{response.timestamp}` — pinning the
 *     clock and catching a "sign vault.did but return selectedDid" / twin-Date.now.
 * The public-key strip is asserted directly (no `d` in the response).
 */
import { describe, it, expect, vi } from 'vitest'
import { handleSignDocumentApprove } from './sign-document-approve.handler'
import { createGatedSign, type PresenceGate } from '@/background/crypto/gated-sign'
import type { VaultData } from '@/stores/wallet'

const SENTINEL = new Uint8Array([0xab, 0xcd, 0xef, 0x01])
const SENTINEL_B64 = btoa(String.fromCharCode(...SENTINEL))
const CLOCK_MS = 1_700_000_000_000
const TOKEN = 'tok-123'

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
  // rawSign is the composition-root-only signer; here a spy returning a sentinel.
  const rawSign = vi.fn(async (_payload: Uint8Array) => ({ bytes: SENTINEL }))
  const crypto = {
    sign: createGatedSign({ assertPresence: gate, rawSign }), // the REAL gated primitive
    deriveForOrigin: vi.fn(),
  }
  const read = vi.fn(async () => vault)
  const ctx = { store: { read }, crypto, clock: { now: () => CLOCK_MS } }
  return { ctx, rawSign, read }
}

/** Decode the exact bytes rawSign was handed back to a UTF-8 string. */
function signedText(rawSign: ReturnType<typeof vi.fn>): string {
  const bytes = rawSign.mock.calls[0][0] as Uint8Array
  return new TextDecoder().decode(bytes)
}

describe('handleSignDocumentApprove — characterization (parity-to-legacy)', () => {
  it('happy path (selectedDid): signs the canonical payload through the gate, returns stripped pubkey', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())

    const result = await handleSignDocumentApprove(
      { signingToken: TOKEN, selectedDid: 'did:sns:alice.attestto.sol' },
      ctx,
    )

    expect(result).toEqual({
      ok: true,
      did: 'did:sns:alice.attestto.sol',
      signature: SENTINEL_B64,
      timestamp: String(CLOCK_MS),
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'PUB_X', y: 'PUB_Y' },
    })
    expect(rawSign).toHaveBeenCalledTimes(1)
  })

  it('REFERENT — the emitted signature is base64 of the GATED signer output (not a raw/derived path)', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)
    expect(result.ok && result.signature).toBe(SENTINEL_B64)
  })

  it('CROSS-TIE — the SIGNED bytes carry the same did+ts as the response (pins clock, catches sign≠return)', async () => {
    const { ctx, rawSign } = makeCtx(makeVault())
    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    // what was actually signed === what the response claims was signed
    expect(signedText(rawSign)).toBe(`attestto:sign:${TOKEN}:${result.did}:${result.timestamp}`)
  })

  it('POSITIVE CONTROL — public-key strip: response pubkey never carries `d`', async () => {
    const { ctx } = makeCtx(makeVault())
    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    expect('d' in result.publicKeyJwk).toBe(false)
    expect(JSON.stringify(result.publicKeyJwk)).not.toContain('ROOT_SECRET')
  })

  it('FAIL-CLOSED (per-family referent) — gate rejects → NO signature, rawSign NEVER called', async () => {
    const gate: PresenceGate = vi.fn(async () => {
      throw new Error('USER_VERIFICATION_CANCELLED')
    })
    const { ctx, rawSign } = makeCtx(makeVault(), { gate })

    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)

    expect(result).toEqual({ ok: false, error: 'USER_VERIFICATION_CANCELLED' })
    expect('signature' in result).toBe(false) // no signature emitted
    expect(rawSign).not.toHaveBeenCalled() // ← the AD-11c invariant, observable
  })

  it('DID precedence: selectedDid absent → vault.holderDid wins over vault.did', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: 'did:holder', did: 'did:jwk:root' }))
    const result = await handleSignDocumentApprove({ signingToken: TOKEN }, ctx)
    expect(result.ok && result.did).toBe('did:holder')
  })

  it('DID precedence: selectedDid + holderDid absent → falls back to vault.did', async () => {
    const { ctx } = makeCtx(makeVault({ holderDid: undefined, did: 'did:jwk:root' }))
    const result = await handleSignDocumentApprove({ signingToken: TOKEN }, ctx)
    expect(result.ok && result.did).toBe('did:jwk:root')
  })

  it('no DID anywhere → "No DID configured", rawSign not called', async () => {
    const { ctx, rawSign } = makeCtx(makeVault({ holderDid: undefined, did: undefined }))
    const result = await handleSignDocumentApprove({ signingToken: TOKEN }, ctx)
    expect(result).toEqual({ ok: false, error: 'No DID configured' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('vault locked (read → null) → "Vault not ready", rawSign not called', async () => {
    const { ctx, rawSign } = makeCtx(null)
    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('vault present but no privateKeyJwk → "Vault not ready", rawSign not called', async () => {
    const { ctx, rawSign } = makeCtx(makeVault({ privateKeyJwk: null }))
    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)
    expect(result).toEqual({ ok: false, error: 'Vault not ready' })
    expect(rawSign).not.toHaveBeenCalled()
  })

  it('publicKeyJwk defaults kty/crv when the stored JWK omits them', async () => {
    const { ctx } = makeCtx(makeVault({ privateKeyJwk: { x: 'PUB_X', y: 'PUB_Y', d: 'S' } as JsonWebKey }))
    const result = await handleSignDocumentApprove({ signingToken: TOKEN, selectedDid: 'did:x' }, ctx)
    if (!result.ok) throw new Error('expected ok')
    expect(result.publicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'PUB_X', y: 'PUB_Y' })
  })
})
