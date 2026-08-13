/**
 * SOC-145 — the proprietary protocol's `requestedFields`, and why it refuses.
 *
 * `navigator.credentials.get({ attesttoVP: … })` sends `protocol: 'attestto'`
 * and may name the claims it wants. Routing that protocol through the approval
 * window (the other half of SOC-145) means those requests now reach
 * `handleChapiApprove`, which had nowhere to put the list.
 *
 * Both obvious ways to handle it are wrong today:
 *
 * - **Ignore the list.** A page asking for a birth year receives the whole
 *   identity credential. The field exists to prevent exactly that.
 * - **Reduce and present.** `createChapiVp` can, but a strict subset drops the
 *   issuer's proof — it no longer covers the reduced document — and the
 *   response carries nothing that tells the verifier. They would check a
 *   holder's word about themselves while believing they had checked the
 *   issuer's.
 *
 * So a request that would reduce is refused. These tests pin that it refuses
 * for the right reason and, just as importantly, that it does NOT refuse the
 * requests it can serve — a guard that rejected everything would look identical
 * from the outside while making the default protocol useless again.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleChapiApprove } from './chapi-approve.handler'

const SENTINEL = new Uint8Array([0xca, 0xfe, 0xba, 0xbe])

/** A json-ld credential whose subject carries exactly `keys`. */
function credWithSubject(keys: string[]) {
  const subject: Record<string, unknown> = { id: 'did:example:holder' }
  for (const k of keys) subject[k] = `value-of-${k}`
  return {
    id: `cred-${keys.join('-')}`,
    format: 'json-ld' as const,
    raw: JSON.stringify({
      type: ['VerifiableCredential'],
      issuer: 'did:issuer:cr',
      credentialSubject: subject,
      proof: { type: 'DataIntegrityProof', proofValue: 'ISSUER_PROOF' },
    }),
    issuer: 'did:issuer:cr',
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    types: ['VerifiableCredential'],
    decodedClaims: {},
    metadata: { addedAt: '2026-01-01T00:00:00Z', source: 'manual' as const },
  }
}

function ctxWith(subjectKeys: string[]) {
  const vault = {
    did: 'did:jwk:root',
    holderDid: 'did:sns:alice.attestto.sol',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', d: 'S' },
    verificationMethod: 'did:sns:alice.attestto.sol#solana-key',
    credentials: [credWithSubject(subjectKeys)],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
    linkedIdentities: [],
  }
  return {
    store: { read: vi.fn(async () => vault) },
    crypto: { sign: vi.fn(async () => ({ bytes: SENTINEL })), deriveForOrigin: vi.fn() },
  }
}

/** A proprietary request: no challenge, no domain, nonce + audience instead. */
function proprietary(requestedFields: string[] | null) {
  return {
    challenge: null,
    nonce: 'nonce-from-the-page',
    domain: null,
    origin: 'https://rp.example',
    requestedFields,
  }
}

describe('requestedFields — a reduction is refused, not performed', () => {
  it('refuses when the request would withhold a claim the credential carries', async () => {
    const ctx = ctxWith(['id', 'givenName', 'birthDate', 'nationalId'])

    const result = await handleChapiApprove(proprietary(['givenName']), ctx)

    expect(result.ok, 'a reduced presentation was built and returned').toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/subset of a credential/i)
    expect(
      result.error,
      'the refusal does not say why, so a relying party cannot tell a capability ' +
        'gap from a user declining',
    ).toMatch(/issuer proof/i)
    expect(
      ctx.crypto.sign,
      'the wallet signed something before deciding it would not present it',
    ).not.toHaveBeenCalled()
  })

  it('serves a request that names every claim, which reduces nothing', async () => {
    const ctx = ctxWith(['id', 'givenName'])

    // Control case. Without it, a guard that refused every non-empty list would
    // pass the test above while making the default protocol permanently useless
    // — the same "fails closed so it must be fine" trap this repo keeps finding.
    const result = await handleChapiApprove(proprietary(['id', 'givenName']), ctx)

    expect(result.ok, 'a full presentation spelled as a field list was refused').toBe(true)
  })

  it('serves a request that names no fields at all', async () => {
    const ctx = ctxWith(['id', 'givenName'])

    // CHAPI has no `requestedFields`, and a proprietary caller may omit it.
    // Absent must mean "present whole", not "present nothing".
    const result = await handleChapiApprove(proprietary(null), ctx)

    expect(result.ok).toBe(true)
  })

  it('serves a request naming a claim the credential does not carry', async () => {
    const ctx = ctxWith(['id', 'givenName'])

    // Asking for more than exists withholds nothing, so there is no reduction
    // to refuse. The verifier simply does not get a claim nobody issued.
    const result = await handleChapiApprove(proprietary(['id', 'givenName', 'notIssued']), ctx)

    expect(result.ok).toBe(true)
  })

  it('leaves CHAPI untouched', async () => {
    const ctx = ctxWith(['id', 'givenName', 'birthDate'])

    // CHAPI never sets requestedFields, so the SOC-145 policy must be invisible
    // to it. Its shape is challenge+domain, and it presents whole as it always
    // has.
    const result = await handleChapiApprove(
      { challenge: 'chal', nonce: 'n', domain: 'rp.example', origin: 'https://rp.example' },
      ctx,
    )

    expect(result.ok).toBe(true)
  })
})
