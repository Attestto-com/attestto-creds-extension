import { describe, it, expect, vi } from 'vitest'
import { buildPresentationResponse, claimToSubjectField } from './oid4vp-presentation'
import type { AuthorizationRequest } from './oid4vp-request'

/**
 * Story 2.4 — building the direct_post response, written test-first.
 *
 * The Story 1.17 lesson drives this file. There, `approvedFields` was RECORDED
 * and then IGNORED on the JSON-LD path: the stored record said two claims and
 * the wire carried all of them. So the assertions here scan the SERIALIZED
 * artefact — and the vp_token is a JWS, whose payload is base64url, so a
 * `not.toContain` against the token itself would be VACUOUS. Every leak check
 * decodes first. That was the exact mistake made in 1.17's own spec.
 */

const CLIENT = 'did:web:verifier.example.org'
const HOLDER = 'did:jwk:abc'
const HOLDER_VM = `${HOLDER}#0`

const REQUEST: AuthorizationRequest = {
  clientId: CLIENT,
  clientIdScheme: 'did',
  responseMode: 'direct_post',
  responseUri: 'https://verifier.example.org/present',
  nonce: 'nonce-0123456789abcdef',
  state: 'state-xyz',
  requestedClaims: ['$.credentialSubject.name', '$.credentialSubject.dob'],
  verified: false,
}

const CREDENTIAL = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  issuer: 'did:web:issuer.example.org',
  credentialSubject: {
    id: HOLDER,
    name: 'A. Person',
    dob: '1990-01-01',
    cedula: 'LEAK-CEDULA-101100999',
    salary: 'LEAK-SALARY-9999',
  },
  proof: { type: 'Ed25519Signature2020', jws: 'issuer-sig' },
}

/** Decode a compact JWS payload — the independent referent for leak checks. */
function decodePayload(jws: string): Record<string, unknown> {
  const part = jws.split('.')[1]
  const padded = part.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as Record<
    string,
    unknown
  >
}

/**
 * A credential containing EXACTLY the claims the verifier asks for. After the
 * 2026-08-09 refusal decision this is the only JSON-LD shape that can still be
 * presented — see the "what the refusal costs" block at the bottom.
 */
const EXACT_CREDENTIAL = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  issuer: 'did:web:issuer.example.org',
  credentialSubject: { id: HOLDER, name: 'A. Person' },
  proof: { type: 'Ed25519Signature2020', jws: 'issuer-sig' },
}

const NAME_ONLY_REQUEST: AuthorizationRequest = {
  ...REQUEST,
  requestedClaims: ['$.credentialSubject.name'],
}

const signer = vi.fn(async () => new Uint8Array([1, 2, 3]))

async function build(over: Partial<Parameters<typeof buildPresentationResponse>[0]> = {}) {
  return await buildPresentationResponse({
    request: NAME_ONLY_REQUEST,
    approvedClaims: ['$.credentialSubject.name'],
    credential: EXACT_CREDENTIAL,
    holderDid: HOLDER,
    holderVerificationMethod: HOLDER_VM,
    sign: signer,
    ...over,
  })
}

describe('claimToSubjectField', () => {
  it('maps a credentialSubject JSONPath to its field name', () => {
    expect(claimToSubjectField('$.credentialSubject.name')).toBe('name')
  })

  it.each(['$.issuer', '$.credentialSubject', 'name', '', '$.credentialSubject.a.b'])(
    'returns null for the unsupported path %j',
    (path) => {
      expect(claimToSubjectField(path)).toBeNull()
    },
  )
})

describe('buildPresentationResponse — the approved set is the disclosed set', () => {
  it('discloses only the approved claim', async () => {
    const result = await build()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const payload = decodePayload(result.value.vp_token)
    const vp = payload.vp as Record<string, unknown>
    const vc = (vp.verifiableCredential as Record<string, unknown>[])[0]
    const subject = vc.credentialSubject as Record<string, unknown>

    expect(Object.keys(subject).sort()).toEqual(['id', 'name'])
  })

  /**
   * 🩸 The 1.17 mistake, not repeated: this decodes before scanning. Asserting
   * `not.toContain` against the raw JWS could never fail, because the payload
   * is base64url.
   */
  it('🔒 no unapproved value survives into the DECODED token', async () => {
    const result = await build()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const decoded = JSON.stringify(decodePayload(result.value.vp_token))
    expect(decoded).toContain('A. Person') // positive control
    expect(decoded).not.toContain('LEAK-CEDULA-101100999')
    expect(decoded).not.toContain('LEAK-SALARY-9999')
  })

  it('🛑 a credential carrying MORE than was approved is refused outright', async () => {
    // CREDENTIAL holds cedula and salary the verifier never asked for. Before
    // 2026-08-09 this emitted a proof-stripped derivation; now it refuses, so
    // the sentinels cannot leak because nothing is built at all.
    const result = await build({ credential: CREDENTIAL, request: NAME_ONLY_REQUEST })
    expect(result).toEqual({ ok: false, reason: 'partial-disclosure-unsupported' })
    expect(JSON.stringify(result)).not.toContain('LEAK-CEDULA-101100999')
  })

  it('🔒 no unapproved value survives anywhere in the whole POST body', async () => {
    // Wider referent than the token: the submission and any future field too.
    const result = await build()
    if (!result.ok) return
    const whole = JSON.stringify({
      ...result.value,
      decoded: decodePayload(result.value.vp_token),
    })
    expect(whole).not.toContain('LEAK-CEDULA-101100999')
    expect(whole).not.toContain('LEAK-SALARY-9999')
  })

  it('🔒 refuses an approved claim that was never requested', async () => {
    // Approval cannot widen the request. Otherwise a compromised consent screen
    // could disclose more than the verifier asked for.
    const result = await build({ approvedClaims: ['$.credentialSubject.salary'] })
    expect(result).toEqual({ ok: false, reason: 'approved-claim-not-requested' })
  })

  it('refuses when nothing was approved', async () => {
    expect(await build({ approvedClaims: [] })).toEqual({ ok: false, reason: 'no-approved-claims' })
  })

  it('🛑 approving a strict subset of a multi-claim credential is refused', async () => {
    const result = await buildPresentationResponse({
      request: REQUEST, // asks for name + dob
      approvedClaims: ['$.credentialSubject.name'], // user approves only one
      credential: CREDENTIAL,
      holderDid: HOLDER,
      holderVerificationMethod: HOLDER_VM,
      sign: signer,
    })
    expect(result).toEqual({ ok: false, reason: 'partial-disclosure-unsupported' })
  })
})

/**
 * 🔒 Replay. A presentation not bound to this request's nonce and audience can
 * be captured and replayed at any other verifier that accepts it.
 */
describe('buildPresentationResponse — replay binding', () => {
  it('binds the nonce into the SIGNED payload', async () => {
    const result = await build()
    if (!result.ok) return
    expect(decodePayload(result.value.vp_token).nonce).toBe(REQUEST.nonce)
  })

  it('binds the audience to the client_id', async () => {
    const result = await build()
    if (!result.ok) return
    expect(decodePayload(result.value.vp_token).aud).toBe(CLIENT)
  })

  it('sets the issuer and subject to the holder', async () => {
    const result = await build()
    if (!result.ok) return
    const payload = decodePayload(result.value.vp_token)
    expect(payload.iss).toBe(HOLDER)
    expect(payload.sub).toBe(HOLDER)
  })

  it('the binding is inside the signature, not merely alongside it', async () => {
    // The referent: what the signer was asked to sign must itself contain the
    // nonce. A nonce added to the body after signing binds nothing.
    const captured: string[] = []
    const capturing = vi.fn(async (input: Uint8Array) => {
      captured.push(new TextDecoder().decode(input))
      return new Uint8Array([9])
    })
    await build({ sign: capturing })
    expect(captured).toHaveLength(1)
    const signingInput = captured[0]
    const payloadPart = signingInput.split('.')[1]
    const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const signed = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    expect(signed).toContain(REQUEST.nonce)
    expect(signed).toContain(CLIENT)
  })
})

describe('buildPresentationResponse — the POST body', () => {
  it('carries exactly the direct_post fields', async () => {
    const result = await build()
    if (!result.ok) return
    expect(Object.keys(result.value).sort()).toEqual([
      'presentation_submission',
      'state',
      'vp_token',
    ])
  })

  it('echoes the state verbatim', async () => {
    const result = await build()
    if (!result.ok) return
    expect(result.value.state).toBe('state-xyz')
  })

  it('omits state when the request had none', async () => {
    const result = await build({ request: { ...REQUEST, state: null } })
    if (!result.ok) return
    expect(Object.keys(result.value).sort()).toEqual(['presentation_submission', 'vp_token'])
  })

  it('builds a presentation_submission describing what was sent', async () => {
    const result = await build()
    if (!result.ok) return
    const submission = result.value.presentation_submission
    expect(submission.definition_id).toBe('pd')
    expect(submission.descriptor_map).toHaveLength(1)
    expect(submission.descriptor_map[0].format).toBe('jwt_vp')
    expect(submission.descriptor_map[0].path).toBe('$')
  })
})

/**
 * 🛑 WHAT THE REFUSAL COSTS — the consequence of the 2026-08-09 decision,
 * written as executable tests rather than left for someone to discover.
 *
 * "Refuse partial disclosure" sounds like it only blocks the case where a user
 * declines some of what a verifier asked for. In OID4VP it is much broader:
 * disclosure is judged against the CREDENTIAL's claims, not the verifier's
 * request. A verifier asking for 2 claims from a credential holding 5 is a
 * partial disclosure even when the user approves both — so it refuses.
 *
 * Practically: a JSON-LD credential can only be presented when it holds exactly
 * the claims being asked for. Real credentials rarely do. So JSON-LD is
 * effectively unusable over OID4VP until SD-JWT issuance lands, and that makes
 * the Phase 2 format work a PREREQUISITE for this path rather than an
 * improvement to it.
 */
describe('what the refusal costs — JSON-LD over OID4VP', () => {
  it('a realistic request (2 of 5 claims, both approved) still refuses', async () => {
    const result = await buildPresentationResponse({
      request: REQUEST, // name + dob
      approvedClaims: ['$.credentialSubject.name', '$.credentialSubject.dob'],
      credential: CREDENTIAL, // also holds cedula + salary
      holderDid: HOLDER,
      holderVerificationMethod: HOLDER_VM,
      sign: signer,
    })
    expect(result).toEqual({ ok: false, reason: 'partial-disclosure-unsupported' })
  })

  it('only an exactly-matching credential can be presented', async () => {
    const result = await buildPresentationResponse({
      request: NAME_ONLY_REQUEST,
      approvedClaims: ['$.credentialSubject.name'],
      credential: EXACT_CREDENTIAL,
      holderDid: HOLDER,
      holderVerificationMethod: HOLDER_VM,
      sign: signer,
    })
    expect(result.ok).toBe(true)
  })

  it('and it keeps the issuer proof, which is the point of refusing', async () => {
    const result = await build()
    if (!result.ok) return
    const vp = decodePayload(result.value.vp_token).vp as Record<string, unknown>
    const vc = (vp.verifiableCredential as Record<string, unknown>[])[0]
    expect(vc.proof).toEqual({ type: 'Ed25519Signature2020', jws: 'issuer-sig' })
  })
})

describe('buildPresentationResponse — fail closed', () => {
  it('rejects a claim path it cannot map to a subject field', async () => {
    const result = await build({
      request: { ...REQUEST, requestedClaims: ['$.issuer'] },
      approvedClaims: ['$.issuer'],
    })
    expect(result).toEqual({ ok: false, reason: 'unsupported-claim-path' })
  })

  it('surfaces a signer failure rather than emitting an unsigned token', async () => {
    const failing = vi.fn(async () => {
      throw new Error('key unavailable')
    })
    expect(await build({ sign: failing })).toEqual({ ok: false, reason: 'signing-failed' })
  })

  it('never returns a token when it returns not-ok', async () => {
    const failing = vi.fn(async () => {
      throw new Error('nope')
    })
    const result = await build({ sign: failing })
    expect(JSON.stringify(result)).not.toContain('vp_token')
  })
})
