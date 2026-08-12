/**
 * SOC-174 Class B — a VP names the key it was signed with. It does not guess.
 *
 * `createChapiVp` defaulted its `kid` / `proof.verificationMethod` to
 * `${holderDid}#key-1` whenever the caller passed no `verificationMethod`.
 *
 * The parameter is method-agnostic: the holder DID can be `did:jwk`, `did:web`,
 * `did:sns`, anything. `#key-1` is not a universal fragment — it is one
 * method's convention. `did:sns` §8.5 names the owner key `#solana-key` (the
 * resolver now emits exactly that, SOC-174 Class A), and `did:jwk` identities
 * in this wallet carry `#0`.
 *
 * What the default produced was not a broken VP that fails loudly. It produced
 * a **well-formed VP that names a verification method the holder's DID Document
 * does not contain**, so the failure surfaces at the verifier as an
 * indistinguishable "signature invalid" — the caller cannot tell a wrong key
 * from a wrong key *name*.
 *
 * Guessing is never better than refusing here, because the wallet always knows
 * its own verification method when it is entitled to sign at all: `wallet.ts`
 * sets it for `did:jwk` at creation, and `did-sync.handler.ts` writes the one
 * the platform sends. If neither happened, the correct answer is that this
 * wallet cannot yet produce a verifiable presentation for this DID — not a
 * fabricated fragment.
 */
import { describe, it, expect } from 'vitest'
import { createChapiVp } from './jsonld-vp'

const SIGN = async () => new Uint8Array([1, 2, 3])

const base = {
  credentials: [] as Array<Record<string, unknown>>,
  sign: SIGN,
  challenge: 'c',
  domain: 'https://verifier.example',
}

/** The JOSE header of a compact JWS, decoded. */
function headerOf(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString('utf-8'))
}

describe('SOC-174 — the verification method is never invented', () => {
  it('uses the fragment the caller supplies, whatever the method', async () => {
    // A did:sns holder, whose owner key is `#solana-key` per §8.5 — NOT `#key-1`.
    const vm = 'did:sns:alice.crbank#solana-key'
    const vp = await createChapiVp({
      ...base,
      holderDid: 'did:sns:alice.crbank',
      verificationMethod: vm,
    })

    const proof = vp.proof as Record<string, unknown>
    expect(proof.verificationMethod).toBe(vm)
    // The proof and the JWS header must name the SAME key. A verifier may read
    // either; if they disagree, one of them is decorative.
    expect(headerOf(proof.jws as string).kid).toBe(vm)
  })

  it('a did:jwk holder keeps its #0 fragment', async () => {
    const vm = 'did:jwk:eyJrdHkiOiJFQyJ9#0'
    const vp = await createChapiVp({
      ...base,
      holderDid: 'did:jwk:eyJrdHkiOiJFQyJ9',
      verificationMethod: vm,
    })

    expect((vp.proof as Record<string, unknown>).verificationMethod).toBe(vm)
  })

  it('REFUSES to build a VP when the verification method is unknown', async () => {
    // The assertion that would have caught the defect. Previously this produced
    // a VP naming `${holderDid}#key-1`, which no did:sns or did:jwk document
    // contains.
    await expect(
      // The type now requires it, and the runtime guard still has to exist: a
      // type is not a constraint. `chapi-approve.handler` reads this value out
      // of stored vault JSON, which TypeScript never checked.
      // @ts-expect-error — deliberately omitting the now-required field
      createChapiVp({ ...base, holderDid: 'did:sns:alice.crbank' }),
    ).rejects.toThrow(/verification method/i)
  })

  it('refuses a verification method belonging to a different DID', async () => {
    // Signing a VP for `alice` while naming `mallory`'s key produces a document
    // whose proof points at a key the holder does not control. Cheap to check,
    // and the check has to live where the VP is built.
    await expect(
      createChapiVp({
        ...base,
        holderDid: 'did:sns:alice.crbank',
        verificationMethod: 'did:sns:mallory.crbank#solana-key',
      }),
    ).rejects.toThrow(/does not belong/i)
  })

  it('refuses a bare DID with no fragment at all', async () => {
    // `kid: holderDid` names a document, not a key inside it. A verifier has to
    // pick a method, and picking is what this ticket is about.
    await expect(
      createChapiVp({
        ...base,
        holderDid: 'did:sns:alice.crbank',
        verificationMethod: 'did:sns:alice.crbank',
      }),
    ).rejects.toThrow(/fragment/i)
  })
})
