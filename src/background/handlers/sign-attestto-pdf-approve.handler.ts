/**
 * Story 1.11 — the `SIGN_ATTESTTO_PDF_APPROVE` signing core, extracted from the
 * legacy switch (`background.ts:2014-2081`). The APDF flow differs from the P-256
 * families: it signs OPAQUE bytes (`atob(payloadB64)` — the background never
 * re-canonicalizes; the verify-side owns the canonical shape) with an **Ed25519**
 * key, and it is a WRITER — the key is minted lazily on first use.
 *
 * F1 (the writer seam): the handler does NOT hold the private key or call
 * `writeVault`/`syncPublicVault`. It provisions through the narrow `Provisioning`
 * port, which returns only the PUBLIC key (`publicKeyB64`) and internally owns the
 * lazy keygen + vault write + public mirror. keys-never-mirrored is therefore the
 * adapter's `toPublicVault` strip (a construct-only allowlist that never carries
 * `ed25519PrivateKeyJwk`), NOT something the handler can bypass — it has no mirror
 * capability by construction (like Story 1.10).
 *
 * Signing routes through the gated `ctx.crypto.sign` (AD-11c), bound by the adapter
 * to the just-provisioned Ed25519 key; the handler never sees key material. The
 * 64-byte length guard is preserved (a wrong-length signature throws → error result,
 * no signature emitted).
 */
import type { SigningCtx } from '@/background/ctx/ctx-bundles'
import type { Provisioning } from '@/background/ports/ports'

/** The APDF ctx: read-only vault + the narrow provisioning capability + the gated signer. */
export type ApdfApproveCtx = Pick<SigningCtx, 'store' | 'crypto'> & { provisioning: Provisioning }

/** From the pending request (`payloadB64`) + the approve message (`selectedDid`). */
export interface ApdfApproveInput {
  payloadB64: string
  selectedDid?: string
}

export type ApdfApproveResult =
  | { ok: true; did: string; signature: string; publicKey: string }
  | { ok: false; error: string }

export async function handleSignAttesttoPdfApprove(
  input: ApdfApproveInput,
  ctx: ApdfApproveCtx,
): Promise<ApdfApproveResult> {
  try {
    const vault = await ctx.store.read()
    if (!vault) {
      return { ok: false, error: 'Vault not ready' }
    }

    // Provision the Ed25519 key (lazy-gen + write + mirror live in the adapter; only
    // the public key comes back). This must precede signing — the gated signer is
    // bound to the key this provisions.
    const ed = await ctx.provisioning.provisionEd25519()
    if (!ed) {
      return { ok: false, error: 'Could not load Ed25519 key' }
    }

    // Decode the canonical payload bytes the page sent. The background does NOT
    // inspect or re-canonicalize them — the verify-side is the single source of
    // truth for the canonical shape (lockstep contract).
    const payloadBytes = Uint8Array.from(atob(input.payloadB64), (c) => c.charCodeAt(0))

    const sig = await ctx.crypto.sign(payloadBytes)
    if (sig.bytes.length !== 64) {
      throw new Error(`Unexpected Ed25519 signature length: ${sig.bytes.length}`)
    }
    const signatureB64 = btoa(String.fromCharCode(...sig.bytes))

    // Issuer DID — honestly labels what this key actually is (not a fake did:key).
    // The verifier doesn't resolve DIDs; it uses the embedded raw publicKey.
    const holderDid =
      input.selectedDid || vault.holderDid || `did:key-vault:ed25519-${ed.publicKeyB64.slice(0, 12)}`

    return { ok: true, did: holderDid, signature: signatureB64, publicKey: ed.publicKeyB64 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Attestto PDF signing failed' }
  }
}
