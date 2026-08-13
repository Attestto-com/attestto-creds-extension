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
  /**
   * SOC-145 — the Attestto-proprietary protocol's `requestedFields`.
   *
   * Absent for CHAPI, which has no equivalent. Present, and possibly a strict
   * subset of the credential's subject keys, for the proprietary protocol that
   * `navigator.credentials.get` uses by default.
   *
   * See `assertNoSilentReduction` below for why a strict subset is refused
   * rather than served.
   */
  requestedFields?: readonly string[] | null
}

/** Subject keys a verifier could be asking for, across every credential presented. */
function subjectKeys(vcs: Array<Record<string, unknown>>): Set<string> {
  const keys = new Set<string>()
  for (const vc of vcs) {
    const subject = vc.credentialSubject
    if (subject && typeof subject === 'object' && !Array.isArray(subject)) {
      for (const k of Object.keys(subject)) keys.add(k)
    }
  }
  return keys
}

/**
 * SOC-145 — refuse a partial disclosure rather than perform one silently.
 *
 * The proprietary protocol lets a page name the claims it wants. Two ways to
 * honour that are both wrong today, which is why this refuses instead:
 *
 * - **Ignore the list and present whole.** A page asking for a birth year gets
 *   the entire identity credential. The field exists precisely to prevent that,
 *   so ignoring it turns a routing bug into a disclosure bug.
 * - **Reduce and present anyway.** `createChapiVp`'s `selectedFields` can do it,
 *   but a strict subset produces a HOLDER-attested derivation: the issuer's
 *   proof is dropped, because it no longer covers the reduced document
 *   (`jsonld-vp.ts:26`). The response carries nothing that tells the relying
 *   party this happened, so they would verify a holder's word about themselves
 *   believing they had verified the issuer's.
 *
 * Refusing is the only option that cannot make a verifier believe something
 * false. It is also honest about capability: the caller learns the wallet will
 * not do this yet, instead of receiving a weaker credential that looks the same.
 *
 * A list naming every subject key requests no reduction at all, so it is served
 * normally — that is a full presentation by another spelling, not a subset.
 */
function assertNoSilentReduction(
  requestedFields: readonly string[] | null | undefined,
  vcs: Array<Record<string, unknown>>,
): string | null {
  if (!requestedFields || requestedFields.length === 0) return null

  const available = subjectKeys(vcs)
  const withheld = [...available].filter((k) => !requestedFields.includes(k))
  if (withheld.length === 0) return null

  return (
    'This wallet cannot present a subset of a credential yet. Reducing the claims ' +
    'would drop the issuer proof, leaving a holder-attested document that a ' +
    'verifier could not tell apart from an issuer-attested one. Request the ' +
    'credential whole, or use a credential whose subject is only the claims you need.'
  )
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

  // SOC-145. Checked after the vault read, because the answer depends on which
  // claims this holder actually carries: the same request is a full
  // presentation against one credential and a reduction against another.
  const reductionRefusal = assertNoSilentReduction(input.requestedFields, vcs)
  if (reductionRefusal) {
    return { ok: false, error: reductionRefusal, tabError: reductionRefusal }
  }

  // The proprietary protocol carries `nonce` and `audience` where CHAPI carries
  // `challenge` and `domain`; the case maps `audience` onto `domain` before
  // calling, so both arrive here in the same shape.
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
