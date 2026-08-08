/**
 * Story 1.11 — the `AUTH_APPROVE` login core, extracted from the legacy switch
 * (`background.ts:1862-1974`). The hardest family: TWO protocols, a PAIRWISE
 * per-origin key, and TWO writes.
 *
 * Positive controls preserved:
 *  - Pairwise per-origin DID unlinkability: `provisionSiteDid(origin)` find-or-creates
 *    a unique `did:jwk` per origin (the write + mirror live in the adapter; the
 *    unlinkability property lives in `findOrCreateSiteDid`, proven in its own spec).
 *    `selectedDid` is intentionally ignored — a login handle is not an identity
 *    choice; a site must request a VC to learn anything about the user.
 *  - keys-never-mirrored: `provisionSiteDid` returns only `{ did, publicKeyJwk }` —
 *    never the pairwise private key (AD-2). The gated signer is bound to that key by
 *    the adapter; this handler never sees key material.
 *  - Per-signature gating (AD-11c): BOTH branches sign through `ctx.crypto.sign`
 *    (the cw branch via `signDidAuth`'s injected signer). No key import here.
 *
 * Two writers, two named capabilities (F1): `provisioning.provisionSiteDid` (the
 * per-site key) and `pin` (the sign-in-as-trust decision) — never a generic
 * `vault.write`. Pinning is best-effort: a pin failure never blocks sign-in.
 */
import { signDidAuth, type WalletAuthResponse } from '@/services/did-auth'
import type { SigningCtx } from '@/background/ctx/ctx-bundles'
import type { Provisioning, SitePin, Clock } from '@/background/ports/ports'

export type AuthApproveCtx = Pick<SigningCtx, 'crypto'> & {
  provisioning: Pick<Provisioning, 'provisionSiteDid'>
  pin: SitePin
  clock: Clock
}

/** From the pending auth request (+ its protocol tag). `selectedDid` is ignored. */
export interface AuthApproveInput {
  protocol?: 'cw'
  origin: string
  nonce: string
  /** ISO 8601 timestamp from the request — echoed in the legacy response. */
  timestamp: string
  /** (cw) audience the verifier issued; falls back to origin. */
  audience?: string
}

export type AuthApproveResult =
  | { ok: true; kind: 'cw'; response: WalletAuthResponse }
  | {
      ok: true
      kind: 'legacy'
      did: string
      signature: string
      nonce: string
      timestamp: string
      publicKeyJwk: JsonWebKey
    }
  | { ok: false; error: string }

export async function handleAuthApprove(
  input: AuthApproveInput,
  ctx: AuthApproveCtx,
): Promise<AuthApproveResult> {
  try {
    // Pairwise per-origin DID (find-or-create; write + mirror in the adapter). Only
    // the public half comes back — the gated signer is bound to the private key.
    const site = await ctx.provisioning.provisionSiteDid(input.origin)
    if (!site) {
      return { ok: false, error: 'Vault not ready' }
    }

    // Deciding to sign in IS the trust decision — pin the site (best-effort; a pin
    // failure must never block sign-in). Host is www-stripped to match the pin store.
    try {
      const host = new URL(input.origin).host.toLowerCase().replace(/^www\./, '')
      if (host) await ctx.pin.pin(host)
    } catch {
      // swallow — never block sign-in on a pin failure
    }

    if (input.protocol === 'cw') {
      // credential-wallet:auth (SOC-71) — a fresh timestamp is minted now so the
      // signature lands inside the verifier's freshness window regardless of how
      // long consent took. Signing routes through the injected gated signer.
      const response = await signDidAuth({
        did: site.did,
        nonce: input.nonce,
        audience: input.audience || input.origin,
        origin: input.origin,
        sign: async (bytes) => (await ctx.crypto.sign(bytes)).bytes,
        publicKeyJwk: site.publicKeyJwk,
        timestamp: new Date(ctx.clock.now()).toISOString(),
      })
      return { ok: true, kind: 'cw', response }
    }

    // Legacy attestto:auth proof-of-possession — canonical payload MUST match the
    // backend DidAuthController exactly: ${nonce}|${audience}|${origin}|${timestamp},
    // audience === origin (matching CORTEX's `audience ?? origin`).
    const audience = input.origin
    const canonicalPayload = `${input.nonce}|${audience}|${input.origin}|${input.timestamp}`
    const sig = await ctx.crypto.sign(new TextEncoder().encode(canonicalPayload))
    const signature = btoa(String.fromCharCode(...sig.bytes))

    return {
      ok: true,
      kind: 'legacy',
      did: site.did,
      signature,
      nonce: input.nonce,
      timestamp: input.timestamp,
      publicKeyJwk: site.publicKeyJwk,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Auth signing failed' }
  }
}
