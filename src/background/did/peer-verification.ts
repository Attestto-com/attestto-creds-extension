/**
 * Story 2.2 — the router's stage-6 counterparty checks (AD-9).
 *
 * A route declares WHICH check applies as data; this module holds the
 * implementations; `dispatch` runs them. Handlers cannot reach any of it — the
 * `CounterpartyDid` port is in no ctx bundle (AD-3), so a handler physically
 * cannot hand-roll a weaker check.
 *
 * ── Why the descriptor became a discriminated union ────────────────────────
 *
 * Until this story `Route.verifyPeer` was typed `unknown`, both real routes set
 * it to an object (`{ check: 'envelope' }`), and `dispatch` ran it only when
 * `typeof route.verifyPeer === 'function'`. So both declared checks were INERT,
 * `unknown` meant no type error could say so, and the spec asserting
 * `toEqual({check:'envelope'})` passed while proving nothing about execution.
 * That is the same "control that exists, looks like it covers the invariant, and
 * doesn't" shape this codebase has now produced repeatedly.
 *
 * Two changes make the recurrence a compile error rather than a code review:
 *   - the descriptor is a UNION, so an unrecognised check name fails to type
 *   - `PEER_CHECKS` is a total map keyed on that union, so adding a check kind
 *     without an implementation fails to type
 * And one makes it a test failure: `dispatch` fails closed on a descriptor it
 * has no implementation for, rather than skipping it.
 *
 * ── 🩸 What these checks DO and DO NOT prove ───────────────────────────────
 *
 * Neither check is authentication. Both answer questions about a DID document;
 * neither proves the party that sent the message holds the corresponding
 * private key. Proof-of-control needs a signature over a challenge, which is
 * FR26 and is deliberately still open. The check names below say only what they
 * actually establish, so no reader infers more from a route declaration than is
 * there.
 */
import type { CounterpartyDidResolver } from './did-resolver'

/**
 * DID methods a counterparty may use. `jwk` is self-certifying and offline;
 * `web` is the only network method the resolver supports.
 */
export const ALLOWED_PEER_METHODS = ['jwk', 'web'] as const

/**
 * Which counterparty check a route requires.
 *
 * `vmBinding` — the claimed verification method really is listed in the claimed
 *   DID's document. Stops a page asserting an arbitrary key URI for a DID whose
 *   document does not contain it. Does NOT prove the sender controls that key.
 *
 * `senderResolvable` — the DID in the message envelope parses, uses an allowed
 *   method, and resolves to a document with at least one authentication key.
 *   Stops unresolvable/spoofed-method senders and SSRF-shaped DIDs. Does NOT
 *   prove the message came from that DID — the DIDComm envelope this codebase
 *   parses carries no signature, so there is nothing to verify against. Named
 *   for what it checks rather than `envelope`, which would imply the envelope
 *   had been authenticated.
 */
export type VerifyPeerDescriptor = { check: 'vmBinding' } | { check: 'senderResolvable' }

/** Every check name — used by the exhaustiveness guard and by the specs. */
export type PeerCheckName = VerifyPeerDescriptor['check']

/** What a check receives. `payload` is the route's VALIDATED payload (FR16c). */
export interface PeerCheckInput {
  payload: unknown
  resolver: CounterpartyDidResolver
}

export type PeerCheck = (input: PeerCheckInput) => Promise<boolean>

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * `vmBinding` — used by `DID_SYNC`.
 *
 * The handler writes `payload.verificationMethod` into the vault and later flows
 * read it as the signer reference. Before this check, a page could name any URI
 * it liked. Now the URI must appear in the document the DID itself publishes.
 */
const vmBinding: PeerCheck = async ({ payload, resolver }) => {
  const holderDid = readString(payload, 'holderDid')
  const verificationMethod = readString(payload, 'verificationMethod')
  if (holderDid === null || verificationMethod === null) return false

  let document
  try {
    document = await resolver.resolve(holderDid, { allowMethods: ALLOWED_PEER_METHODS })
  } catch {
    // Unresolvable counterparty = unverified counterparty. Fail closed.
    return false
  }

  // Exact match against a method the document actually defines. `resolve`
  // already guaranteed every method id is scoped to `holderDid`, so this cannot
  // be satisfied by a key belonging to another DID.
  return document.verificationMethod.some((method) => method.id === verificationMethod)
}

/**
 * `senderResolvable` — used by `DIDCOMM_INBOUND`.
 *
 * See the type doc: this is a reachability and well-formedness check on the
 * claimed sender, NOT authentication of the message.
 */
const senderResolvable: PeerCheck = async ({ payload, resolver }) => {
  const from = readString(payload, 'from')
  if (from === null) return false

  let document
  try {
    document = await resolver.resolve(from, { allowMethods: ALLOWED_PEER_METHODS })
  } catch {
    return false
  }

  // A document with no authentication key cannot ever authenticate this sender,
  // so accepting it would be accepting a peer we could never verify.
  return document.authentication.length > 0
}

/**
 * The total check registry. Typed as `Record<PeerCheckName, PeerCheck>`, so
 * adding a member to `VerifyPeerDescriptor` without adding it here is a
 * `vue-tsc` error — the declaration and the implementation cannot drift.
 */
export const PEER_CHECKS: Record<PeerCheckName, PeerCheck> = {
  vmBinding,
  senderResolvable,
}

/**
 * 🩸 The inherited-member hole, found by the spec below rather than by review.
 *
 * `PEER_CHECKS[name]` reaches `Object.prototype` for `toString`, `constructor`,
 * `valueOf` and friends. Every one of those IS a function, so a
 * `typeof check === 'function'` guard admits it, `runPeerCheck` calls it, and
 * `Object.prototype.toString()` returns the NON-EMPTY STRING '[object …]' —
 * truthy. A descriptor of `{ check: 'toString' }` therefore passed peer
 * verification in the first version of this file: a fail-OPEN inside the
 * function written to fail closed.
 *
 * Own-property lookup against a fixed key set closes it. The same shape as
 * `dispatch`'s `isKnownType`, which uses `hasOwnProperty` for exactly this
 * reason — the pattern already existed in the router and this file did not
 * follow it.
 */
const PEER_CHECK_NAMES = new Set<string>(Object.keys(PEER_CHECKS))

/**
 * Run the check a route declared.
 *
 * Fail-closed on a descriptor with no implementation. That branch is
 * unreachable while the types hold, and exists precisely for when they do not —
 * a route object built from JSON, a cast, or a future `as` would otherwise
 * SKIP verification silently, which is the failure this story is fixing.
 */
export async function runPeerCheck(
  descriptor: VerifyPeerDescriptor,
  input: PeerCheckInput,
): Promise<boolean> {
  const name: unknown = descriptor?.check
  if (typeof name !== 'string' || !PEER_CHECK_NAMES.has(name)) return false

  const check = PEER_CHECKS[name as PeerCheckName]
  if (typeof check !== 'function') return false

  // Coerced, not returned raw: a check must decide true/false, and anything
  // else (a truthy string, a Promise of an object) is not a decision.
  return (await check(input)) === true
}
