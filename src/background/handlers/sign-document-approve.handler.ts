/**
 * Story 1.11 — the `SIGN_DOCUMENT_APPROVE` signing core, extracted from the legacy
 * switch (`background.ts:1728-1799`) as a near-verbatim move. The canonical payload
 * assembly, the two readiness guards, the public-key field-strip, and the response
 * shape are pinned HERE; parity-to-legacy is the AC.
 *
 * The ONE architectural inversion (AD-11c/FR19, the point of the story): the legacy
 * imported `vault.privateKeyJwk` and called `crypto.subtle.sign` INLINE. This
 * handler signs ONLY through the injected `ctx.crypto.sign` — the single gated
 * primitive (`createGatedSign`). It never names `crypto.subtle`, never imports a
 * key. A gate rejection propagates into the catch and yields an error response with
 * NO signature (fail-closed), exactly as a signing error did in the legacy.
 *
 * AD-14: the handler returns response DATA; the caller (the switch case, until
 * dispatch owns it) transports it to the tab and acks `sendResponse`. The pending
 * Map, the window-unregister callback, and `senderTabId` are service-worker
 * transport/lifecycle state — they stay in the case (as `senderTabId` did in Story
 * 1.10), so this module is pure and testable. The case passes in `signingToken`
 * (read from the pending row) and `selectedDid` (from the approve message).
 *
 * `ctx.store` is READ-ONLY (`SigningVaultStore`) — a signing handler cannot mutate
 * or mirror the vault (confinement guard). The timestamp comes from `ctx.clock`
 * (was `Date.now()`), so the signed `ts` is deterministic and cross-tie-testable.
 */
import type { SigningCtx } from '@/background/ctx/ctx-bundles'

/** What the case reads from the pending row + the approve message. */
export interface SignDocumentApproveInput {
  /** From the pending `SignDocumentRequestMessage` — part of the canonical payload. */
  signingToken: string
  /** From the approve message; overrides the vault's fallback DID when present. */
  selectedDid?: string
}

/** The stripped public key echoed in the response (never carries `d`). */
export interface SignDocumentPublicKey {
  kty: string
  crv: string
  x?: string
  y?: string
}

/** The `SIGN_DOCUMENT_RESPONSE` payload data (AD-14) the caller sends to the tab. */
export type SignDocumentApproveResult =
  | {
      ok: true
      did: string
      signature: string
      timestamp: string
      publicKeyJwk: SignDocumentPublicKey
    }
  | { ok: false; error: string }

export async function handleSignDocumentApprove(
  input: SignDocumentApproveInput,
  ctx: Pick<SigningCtx, 'store' | 'crypto' | 'clock'>,
): Promise<SignDocumentApproveResult> {
  const vault = await ctx.store.read()
  if (!vault || !vault.privateKeyJwk) {
    return { ok: false, error: 'Vault not ready' }
  }

  const holderDid = input.selectedDid || vault.holderDid || vault.did
  if (!holderDid) {
    return { ok: false, error: 'No DID configured' }
  }

  try {
    const timestamp = String(ctx.clock.now())
    // Canonical signing payload (must match backend verification).
    const canonicalPayload = `attestto:sign:${input.signingToken}:${holderDid}:${timestamp}`
    const data = new TextEncoder().encode(canonicalPayload)

    // The ONLY signing path: the single gated primitive. A gate rejection throws
    // here → caught below → error response, no signature (fail-closed).
    const sig = await ctx.crypto.sign(data)
    const signature = btoa(String.fromCharCode(...sig.bytes))

    const jwk = vault.privateKeyJwk as Record<string, string>
    return {
      ok: true,
      did: holderDid,
      signature,
      timestamp,
      publicKeyJwk: {
        kty: jwk.kty || 'EC',
        crv: jwk.crv || 'P-256',
        x: jwk.x,
        y: jwk.y,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Signing failed' }
  }
}
