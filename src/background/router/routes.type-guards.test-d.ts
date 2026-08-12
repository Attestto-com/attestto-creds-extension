/**
 * Story 1.1 — Channel A: PERMANENT compile-time tripwires for `route ⊇ union`.
 *
 * This file ships no runtime code and Vitest never executes it (it is not a
 * `*.spec.ts`). It is type-checked by `npm run type-check` (`vue-tsc --noEmit`,
 * which includes `src/**\/*.ts`). Each `@ts-expect-error` asserts that a wrong
 * registry shape is REJECTED. If the mapped-type exhaustiveness guarantee ever
 * weakens so the wrong shape becomes legal, the suppressed error disappears, the
 * `@ts-expect-error` becomes an UNUSED SUPPRESSION, and `vue-tsc` fails on the
 * suppression itself — so the mutation is a self-guarding, checked-in tripwire,
 * not a one-time "delete an entry and screenshot the red" ritual (AC4).
 */
import { MESSAGE_ROUTES } from './routes'
import type { Route } from './route'
import type { MessageType } from './message-types'

// ── Tripwire 1: the registry must NOT be assignable to a loose `Record<string,…>`
// (a plain Record would collapse exhaustiveness — the key set would follow the
// object instead of the object following the union). AD-5 / AC2.
declare const looseRegistry: Record<string, Route<MessageType>>
// @ts-expect-error — a loose Record<string,…> cannot satisfy the union-keyed exhaustive registry
const _rejectsLooseRecord: typeof MESSAGE_ROUTES = looseRegistry
void _rejectsLooseRecord

// ── Tripwire 2: a registry MISSING any dispatched type is rejected — this is the
// "add a union member without a route = compile error" guarantee, encoded. AC2 / AC4.
declare const missingOneRoute: Omit<typeof MESSAGE_ROUTES, 'DID_SYNC'>
// @ts-expect-error — a registry missing any dispatched type is not assignable to the exhaustive registry
const _rejectsMissingMember: typeof MESSAGE_ROUTES = missingOneRoute
void _rejectsMissingMember

// Positive control: the real registry IS assignable to the exhaustive type (this
// line must stay green; if it ever needs an @ts-expect-error, exhaustiveness broke).
const _acceptsExhaustive: { [K in MessageType]: Route<K> } = MESSAGE_ROUTES
void _acceptsExhaustive

// AC5 (no member's payload is a disguised `unknown`/`any`) is asserted at the
// payload map's home in `message-types.ts` (`_NoLoosePayloads`), compiled by the
// same `vue-tsc` pass.
