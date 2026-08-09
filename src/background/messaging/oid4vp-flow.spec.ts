import { describe, it, expect, vi } from 'vitest'
import { createOid4vpFlow, type DirectPoster, type Oid4vpPendingRow } from './oid4vp-flow'
import { createPendingFlow } from '@/background/consent/pending-flow'
import { createPendingStore, type PendingStorage } from '@/background/consent/pending-store'

/**
 * Story 2.4 — request → consent → presentation, end to end, written test-first.
 *
 * This module owns no consent machinery of its own: it composes the Story
 * 1.15/1.16 `PendingFlow`, whose atomic claim and tombstone semantics were
 * built and mutation-proven then. Re-implementing "look up, bail if missing,
 * then act" here would be a sixth copy of the pattern that Story 1.16 collapsed
 * precisely because five copies meant five chances to drift.
 */

const CLIENT = 'did:web:verifier.example.org'
const HOLDER = 'did:jwk:holder'
/** Everything the request asks for — the only presentable set on JSON-LD now. */
const APPROVE_ALL = ['$.credentialSubject.name', '$.credentialSubject.dob']

const RAW_REQUEST = {
  client_id: CLIENT,
  client_id_scheme: 'did',
  response_type: 'vp_token',
  response_mode: 'direct_post',
  response_uri: 'https://verifier.example.org/present',
  nonce: 'nonce-0123456789abcdef',
  state: 'st-1',
  presentation_definition: {
    id: 'pd',
    input_descriptors: [
      {
        id: 'a',
        constraints: {
          fields: [{ path: ['$.credentialSubject.name'] }, { path: ['$.credentialSubject.dob'] }],
        },
      },
    ],
  },
}

/**
 * Holds EXACTLY the claims the request asks for.
 *
 * After the 2026-08-09 refusal decision, disclosure is judged against the
 * credential's claims rather than the verifier's request, so a credential
 * carrying anything extra cannot be presented on this format at all. The
 * multi-claim case is covered in `oid4vp-presentation.spec.ts` under "what the
 * refusal costs".
 */
const CREDENTIAL = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  issuer: 'did:web:issuer.example.org',
  credentialSubject: { id: HOLDER, name: 'A. Person', dob: '1990-01-01' },
}

/** Carries a claim nobody asked for, so it can no longer be presented. */
const OVERSTUFFED_CREDENTIAL = {
  ...CREDENTIAL,
  credentialSubject: { ...CREDENTIAL.credentialSubject, cedula: 'LEAK-CEDULA' },
}

/**
 * The REAL `createPendingStore` over in-memory storage.
 *
 * A hand-rolled stub was the first attempt and it was the wrong call: the
 * atomic claim, the tombstone and the missing/alreadyConsumed distinction are
 * the properties this flow depends on, and stubbing them would have tested my
 * re-statement of the contract rather than the contract. Using the production
 * store means a regression in `pending-store.ts` reddens here too.
 */
function memoryStorage(): PendingStorage {
  const data: Record<string, unknown> = {}
  return {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (entries: Record<string, unknown>) => {
      Object.assign(data, entries)
    },
  }
}

function makeFlow(over: { post?: DirectPoster['post']; credential?: Record<string, unknown> } = {}) {
  const post = vi.fn<DirectPoster['post']>(over.post ?? (async () => ({ ok: true, status: 200 })))
  const sign = vi.fn(async () => new Uint8Array([1, 2, 3]))
  const pending = createPendingFlow<Oid4vpPendingRow>(
    createPendingStore({ flow: 'oid4vp', storage: memoryStorage(), now: () => 1_000 }),
  )
  const flow = createOid4vpFlow({
    pending,
    directPost: { post },
    sign,
    holderDid: HOLDER,
    loadCredential: async () => over.credential ?? CREDENTIAL,
  })
  return { flow, post, sign }
}

describe('receive — a request becomes a pending consent record', () => {
  it('parses and stores what the consent screen needs', async () => {
    const { flow } = makeFlow()
    const received = await flow.receive('req-1', RAW_REQUEST)
    expect(received.ok).toBe(true)
    if (!received.ok) return
    expect(received.value.clientId).toBe(CLIENT)
    expect(received.value.requestedClaims).toEqual([
      '$.credentialSubject.name',
      '$.credentialSubject.dob',
    ])
    // The UI must be told the verifier is UNVERIFIED, not merely well-formed.
    expect(received.value.verified).toBe(false)
  })

  it('🔒 a malformed request never becomes pending', async () => {
    const { flow } = makeFlow()
    const received = await flow.receive('req-1', {
      ...RAW_REQUEST,
      response_uri: 'https://attacker.example.org/collect',
    })
    expect(received.ok).toBe(false)
    // The independent referent: nothing to approve afterwards.
    expect(await flow.peek('req-1')).toBeNull()
  })

  it('does not post anything on receive', async () => {
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('approve — consent gates the presentation', () => {
  it('posts a presentation carrying only the approved claim', async () => {
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)

    const result = await flow.approve('req-1', [
      '$.credentialSubject.name',
      '$.credentialSubject.dob',
    ])
    expect(result.ok).toBe(true)
    expect(post).toHaveBeenCalledTimes(1)

    const [uri, body] = post.mock.calls[0]
    expect(uri).toBe('https://verifier.example.org/present')

    // Decode: the token is base64url, so scanning it raw would assert nothing.
    const payloadPart = (body.vp_token as string).split('.')[1]
    const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    expect(decoded).toContain('A. Person')
  })

  it('🔒 a second approval of the same request posts nothing', async () => {
    // Replay: the pending row is a tombstone after the first claim.
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)

    await flow.approve('req-1', APPROVE_ALL)
    const second = await flow.approve('req-1', APPROVE_ALL)

    expect(second.ok).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a replayed approval from an unknown one', async () => {
    const { flow } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)
    await flow.approve('req-1', APPROVE_ALL)

    const replayed = await flow.approve('req-1', APPROVE_ALL)
    const unknown = await flow.approve('never-existed', APPROVE_ALL)
    expect(replayed.ok === false && replayed.reason).toBe('alreadyConsumed')
    expect(unknown.ok === false && unknown.reason).toBe('missing')
  })

  it('🔒 approving a claim the verifier never requested posts nothing', async () => {
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)
    const result = await flow.approve('req-1', ['$.credentialSubject.cedula'])
    expect(result.ok).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('🔒 approving nothing posts nothing', async () => {
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)
    expect((await flow.approve('req-1', [])).ok).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('🛑 a credential holding an unrequested claim is refused, and posts nothing', async () => {
    // The cost of the refusal decision, at the flow level: the user approved
    // everything the verifier asked for and it still cannot be presented,
    // because the credential carries a claim nobody asked about.
    const { flow, post } = makeFlow({ credential: OVERSTUFFED_CREDENTIAL })
    await flow.receive('req-1', RAW_REQUEST)
    const result = await flow.approve('req-1', APPROVE_ALL)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('partial-disclosure-unsupported')
    expect(post).not.toHaveBeenCalled()
  })

  it('reports a verifier rejection without claiming success', async () => {
    const { flow } = makeFlow({ post: async () => ({ ok: false, status: 400 }) })
    await flow.receive('req-1', RAW_REQUEST)
    const result = await flow.approve('req-1', APPROVE_ALL)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('verifier-rejected')
  })
})

describe('deny — nothing leaves', () => {
  it('consumes the row and posts nothing', async () => {
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)

    expect(await flow.deny('req-1')).toBe(true)
    expect(post).not.toHaveBeenCalled()
    // And the request cannot then be approved.
    expect((await flow.approve('req-1', APPROVE_ALL)).ok).toBe(false)
  })

  it('a deny after an approve does not un-send anything, and says so', async () => {
    const { flow, post } = makeFlow()
    await flow.receive('req-1', RAW_REQUEST)
    await flow.approve('req-1', APPROVE_ALL)
    expect(await flow.deny('req-1')).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
  })
})
