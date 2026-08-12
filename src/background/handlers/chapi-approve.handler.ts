/**
 * Story 1.11 — the `CHAPI_APPROVE` presentation core, extracted from the legacy
 * switch (`background.ts:2186-2247`). Unlike SIGN_DOCUMENT/PAYMENT it does not
 * return a bare signature: it builds a CHAPI Verifiable Presentation (via the
 * already-injected-signer `createChapiVp`) and returns it as DATA (AD-14); the case
 * transports the VP to the originating tab.
 *
 * The signing seam (AD-11c): the handler adapts the gated `ctx.crypto.sign` to a
 * `JwsSigner` and hands THAT to `createChapiVp` — which never sees a key. Every VP
 * signature therefore routes through the same gated primitive as the other families.
 * A gate rejection propagates out of `createChapiVp`, is caught, and yields the
 * VP-build error with NO presentation emitted (fail-closed).
 *
 * `createChapiVp` stays a plain import (pure builder taking injected deps, AD-4).
 * `ctx.store` is READ-ONLY (`SigningVaultStore`); the handler does not mutate the vault.
 */
import { createChapiVp } from '@/services/jsonld-vp'
import type { JwsSigner } from '@/services/jws'
import type { SigningCtx } from '@/background/ctx/ctx-bundles'

/** The CHAPI request fields the case reads from the pending row's `apiReq`. */
export interface ChapiApproveInput {
  challenge: string | null
  nonce: string
  domain: string | null
  origin: string
}

export type ChapiApproveResult =
  | { ok: true; holderDid: string; presentation: Record<string, unknown> }
  // `tabError` (when present) is the message sent to the tab; `error` goes to the
  // popup ack. They diverge only for the VP-build failure (legacy parity).
  | { ok: false; error: string; tabError?: string }

export async function handleChapiApprove(
  input: ChapiApproveInput,
  ctx: Pick<SigningCtx, 'store' | 'crypto'>,
): Promise<ChapiApproveResult> {
  const vault = await ctx.store.read()
  if (!vault || !vault.privateKeyJwk) {
    return { ok: false, error: 'Vault not ready' }
  }

  const holderDid =
    vault.holderDid ??
    vault.did ??
    (vault.linkedSolanaAddress ? `did:pkh:solana:${vault.linkedSolanaAddress}` : null)

  if (!holderDid) {
    return { ok: false, error: 'No DID configured' }
  }

  // SOC-174 — refuse rather than guess the key fragment.
  //
  // `createChapiVp` used to fall back to `${holderDid}#key-1`. That is one DID
  // method's convention, not a universal one: `did:sns` §8.5 names the owner key
  // `#solana-key` and this wallet's `did:jwk` identities use `#0`. The fallback
  // produced a well-formed VP naming a key the holder's document does not
  // contain, and the verifier could only report it as a signature failure.
  //
  // The vault carries the real value whenever this wallet may sign at all —
  // `wallet.ts` sets it at did:jwk creation, `did-sync.handler.ts` writes the
  // one the platform sends. Its absence means this identity is not ready to
  // present, which is a different fact from "the signature was wrong" and
  // deserves to be reported as itself.
  if (!vault.verificationMethod) {
    return {
      ok: false,
      error: 'This identity has no verification method yet',
      tabError: 'Failed to build presentation',
    }
  }

  const credentials = (vault.credentials ?? [])
  const vcs = credentials
    .filter((c) => c.format === 'json-ld')
    .map((c) => JSON.parse(c.raw) as Record<string, unknown>)

  const challenge = input.challenge ?? input.nonce ?? ''
  const domain = input.domain ?? input.origin ?? ''

  // Adapt the gated Crypto['sign'] to a JwsSigner (raw bytes). All signing goes
  // through the injected gated primitive — createChapiVp never sees key material.
  const sign: JwsSigner = async (signingInput) => (await ctx.crypto.sign(signingInput)).bytes

  try {
    const presentation = await createChapiVp({
      credentials: vcs,
      holderDid,
      sign,
      challenge,
      domain,
      verificationMethod: vault.verificationMethod,
    })
    return { ok: true, holderDid, presentation }
  } catch {
    return { ok: false, error: 'VP build failed', tabError: 'Failed to build presentation' }
  }
}
