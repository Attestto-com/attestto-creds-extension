/**
 * Story 1.11 — the `PAYMENT_APPROVE` signing core, extracted from the legacy switch
 * (`background.ts:2096-2168`). Twin of `sign-document-approve.handler.ts`: same
 * readiness guards, same public-key strip, same single-gated-primitive signing
 * (AD-11c) — differing only in the canonical payload (no timestamp; the amount is
 * pinned to two decimals) and the response shape (no `timestamp` field).
 *
 * The canonical payload MUST match the backend `DidPaymentResolver.buildPaymentPayload`:
 * `attestto:pay:{uuid}:{did}:{amount.toFixed(2)}`. The `.toFixed(2)` is load-bearing
 * — a re-format to `"10.0"` / `"10"` produces a signature the backend rejects, so the
 * characterization pins the exact byte form of the signed amount.
 *
 * Signs ONLY through `ctx.crypto.sign` (the gated primitive); never imports a key or
 * touches `crypto.subtle`. A gate rejection propagates into the catch → error
 * response, no signature (fail-closed). AD-14: returns DATA; the case transports.
 */
import type { SigningCtx } from '@/background/ctx/ctx-bundles'
import type { SignDocumentPublicKey } from './sign-document-approve.handler'

/** What the case reads from the pending payment row + the approve message. */
export interface PaymentApproveInput {
  /** From the pending `PaymentRequestMessage` — part of the canonical payload. */
  paymentRequestUuid: string
  /** From the pending row — signed as `amount.toFixed(2)` (backend contract). */
  amount: number
  /** From the approve message; overrides the vault's fallback DID when present. */
  selectedDid?: string
}

/** The `PAYMENT_RESPONSE` payload data (AD-14) the caller sends to the tab. */
export type PaymentApproveResult =
  | { ok: true; did: string; signature: string; publicKeyJwk: SignDocumentPublicKey }
  | { ok: false; error: string }

export async function handlePaymentApprove(
  input: PaymentApproveInput,
  ctx: Pick<SigningCtx, 'store' | 'crypto'>,
): Promise<PaymentApproveResult> {
  const vault = await ctx.store.read()
  if (!vault || !vault.privateKeyJwk) {
    return { ok: false, error: 'Vault not ready' }
  }

  const holderDid = input.selectedDid || vault.holderDid || vault.did
  if (!holderDid) {
    return { ok: false, error: 'No DID configured' }
  }

  try {
    // Canonical payment payload (must match backend DidPaymentResolver.buildPaymentPayload).
    const canonicalPayload = `attestto:pay:${input.paymentRequestUuid}:${holderDid}:${input.amount.toFixed(2)}`
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
