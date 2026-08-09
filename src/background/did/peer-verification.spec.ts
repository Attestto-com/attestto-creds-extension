import { describe, it, expect, vi } from 'vitest'
import {
  runPeerCheck,
  PEER_CHECKS,
  ALLOWED_PEER_METHODS,
  type PeerCheckName,
  type VerifyPeerDescriptor,
} from './peer-verification'
import type { CounterpartyDidResolver } from './did-resolver'
import { DidResolutionError } from './did-resolver'

const DID = 'did:web:peer.example'
const VM = `${DID}#key-1`

function resolverStub(
  over: { vmIds?: string[]; authentication?: string[]; throws?: boolean } = {},
) {
  const calls: { did: string; allowMethods: readonly string[] }[] = []
  const resolver: CounterpartyDidResolver = {
    resolve: vi.fn(async (did: string, opts: { allowMethods: readonly string[] }) => {
      calls.push({ did, allowMethods: opts.allowMethods })
      if (over.throws) throw new DidResolutionError('fetch-failed', did)
      const ids = over.vmIds ?? [VM]
      return {
        id: did,
        verificationMethod: ids.map((id) => ({
          id,
          type: 'JsonWebKey2020',
          controller: did,
          publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'aa', y: 'bb' },
        })),
        authentication: over.authentication ?? ids,
        assertionMethod: ids,
      }
    }),
  }
  return { resolver, calls }
}

describe('vmBinding — the claimed verification method must be in the document', () => {
  it('accepts a method the document actually lists', async () => {
    const { resolver, calls } = resolverStub()
    const ok = await runPeerCheck(
      { check: 'vmBinding' },
      { payload: { holderDid: DID, verificationMethod: VM }, resolver },
    )
    expect(ok).toBe(true)
    expect(calls).toEqual([{ did: DID, allowMethods: ALLOWED_PEER_METHODS }])
  })

  it('🔒 rejects a method the document does NOT list', async () => {
    // The control: before this, a page could name any key URI it liked and the
    // handler would write it into the vault as the signer reference.
    const { resolver } = resolverStub({ vmIds: [`${DID}#real-key`] })
    const ok = await runPeerCheck(
      { check: 'vmBinding' },
      { payload: { holderDid: DID, verificationMethod: `${DID}#attacker-key` }, resolver },
    )
    expect(ok).toBe(false)
  })

  it('rejects a method belonging to a different DID', async () => {
    const { resolver } = resolverStub()
    const ok = await runPeerCheck(
      { check: 'vmBinding' },
      {
        payload: { holderDid: DID, verificationMethod: 'did:web:evil.example#key-1' },
        resolver,
      },
    )
    expect(ok).toBe(false)
  })

  it('matches exactly, not by prefix', async () => {
    const { resolver } = resolverStub({ vmIds: [VM] })
    const ok = await runPeerCheck(
      { check: 'vmBinding' },
      { payload: { holderDid: DID, verificationMethod: `${VM}-extra` }, resolver },
    )
    expect(ok).toBe(false)
  })

  it('fails closed when the DID cannot be resolved', async () => {
    const { resolver } = resolverStub({ throws: true })
    const ok = await runPeerCheck(
      { check: 'vmBinding' },
      { payload: { holderDid: DID, verificationMethod: VM }, resolver },
    )
    expect(ok).toBe(false)
  })

  it.each([
    ['a missing holderDid', { verificationMethod: VM }],
    ['a missing verificationMethod', { holderDid: DID }],
    ['an empty holderDid', { holderDid: '', verificationMethod: VM }],
    ['a non-string holderDid', { holderDid: 42, verificationMethod: VM }],
    ['a null payload', null],
    ['a string payload', 'nope'],
  ])('fails closed on %s', async (_label, payload) => {
    const { resolver, calls } = resolverStub()
    expect(await runPeerCheck({ check: 'vmBinding' }, { payload, resolver })).toBe(false)
    // Malformed input must not even reach the network.
    expect(calls).toEqual([])
  })

  it('constrains the resolver to the allowed methods', async () => {
    const { resolver, calls } = resolverStub()
    await runPeerCheck(
      { check: 'vmBinding' },
      { payload: { holderDid: DID, verificationMethod: VM }, resolver },
    )
    expect(calls[0].allowMethods).toEqual(ALLOWED_PEER_METHODS)
    // A check that passed an empty or wide-open list would defeat the resolver's
    // own allowlist, so pin the value rather than just that it was passed.
    expect([...calls[0].allowMethods].sort()).toEqual(['jwk', 'web'])
  })
})

describe('senderResolvable — the claimed sender must resolve', () => {
  it('accepts a sender that resolves with an authentication key', async () => {
    const { resolver, calls } = resolverStub()
    expect(await runPeerCheck({ check: 'senderResolvable' }, { payload: { from: DID }, resolver })).toBe(
      true,
    )
    expect(calls).toEqual([{ did: DID, allowMethods: ALLOWED_PEER_METHODS }])
  })

  it('rejects a sender that does not resolve', async () => {
    const { resolver } = resolverStub({ throws: true })
    expect(await runPeerCheck({ check: 'senderResolvable' }, { payload: { from: DID }, resolver })).toBe(
      false,
    )
  })

  it('rejects a document with no authentication key', async () => {
    // A peer we could never authenticate is a peer we must not accept.
    const { resolver } = resolverStub({ authentication: [] })
    expect(await runPeerCheck({ check: 'senderResolvable' }, { payload: { from: DID }, resolver })).toBe(
      false,
    )
  })

  it.each([[{}], [{ from: '' }], [{ from: 42 }], [null]])(
    'fails closed on the payload %j',
    async (payload) => {
      const { resolver, calls } = resolverStub()
      expect(await runPeerCheck({ check: 'senderResolvable' }, { payload, resolver })).toBe(false)
      expect(calls).toEqual([])
    },
  )

  /**
   * 🩸 Naming honesty. This check is NOT authentication, and the test says so
   * out loud so a future reader does not infer more from the route declaration
   * than is there.
   */
  it('does NOT attempt to verify a signature (there is none in the envelope)', async () => {
    const { resolver } = resolverStub()
    // A message claiming to be from a DID that resolves passes, regardless of
    // any signature material, because nothing here checks one. Proof-of-control
    // is FR26 and remains open.
    const ok = await runPeerCheck(
      { check: 'senderResolvable' },
      { payload: { from: DID, signature: 'OBVIOUSLY-FORGED' }, resolver },
    )
    expect(ok).toBe(true)
  })
})

/**
 * The structural guards. These are what stop the Epic-1 recurrence: a check
 * declared in a route but not implemented, or implemented but never reachable.
 */
describe('the check registry is total and fail-closed', () => {
  it('every descriptor variant has an implementation', () => {
    const names: PeerCheckName[] = ['vmBinding', 'senderResolvable']
    for (const name of names) {
      expect(typeof PEER_CHECKS[name], `${name} has no implementation`).toBe('function')
    }
    // And nothing extra is registered that no descriptor can select.
    expect(Object.keys(PEER_CHECKS).sort()).toEqual([...names].sort())
  })

  it('an unknown check name fails closed rather than throwing or passing', async () => {
    const { resolver } = resolverStub()
    const bogus = { check: 'not-a-real-check' } as unknown as VerifyPeerDescriptor
    expect(await runPeerCheck(bogus, { payload: { from: DID }, resolver })).toBe(false)
  })

  it.each([undefined, null, {}, { check: undefined }])(
    'a malformed descriptor %j fails closed',
    async (descriptor) => {
      const { resolver } = resolverStub()
      expect(
        await runPeerCheck(descriptor as unknown as VerifyPeerDescriptor, {
          payload: { from: DID },
          resolver,
        }),
      ).toBe(false)
    },
  )

  it('a prototype-polluting check name cannot select a function', async () => {
    const { resolver } = resolverStub()
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const descriptor = { check: name } as unknown as VerifyPeerDescriptor
      expect(
        await runPeerCheck(descriptor, { payload: { from: DID }, resolver }),
        `${name} selected something`,
      ).toBe(false)
    }
  })
})
