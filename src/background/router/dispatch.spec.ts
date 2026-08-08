/**
 * Story 1.5 — the router chokepoint pipeline (runtime channel).
 *
 * Every test asserts against an INDEPENDENT referent (which port spy fired, how
 * many times, whether `buildBundle` was called) — never the return value alone
 * (that would be the source-mirror sin). The three gating mutations (i wiring /
 * ii shape / iii authority) plus the replay mutation (iv) each have a positive
 * control so the reject can't be an unrelated always-fail.
 *
 * Fixtures drive the pipeline: `dispatch` takes an injected `routes`, `buildBundle`
 * (required — the real one is the composition root, Story 1.13), `resolveSender`
 * (default = message-guard), and an optional `pending`. `main` is untouched — this
 * file is the ONLY importer of `dispatch` in this story.
 */
import { describe, it, expect, vi } from 'vitest'
import { dispatch, type DispatchDeps, type InboundMessage } from './dispatch'
import type { Route, CtxBundleTag } from './route'
import type { MessageType } from './message-types'
import { MESSAGE_ROUTES } from './routes'

const GOOD = 'https://good.example'

// ── spy bundles: each tier's handler reaches a DISTINCT port method ────────────
// The distinct method is the referent for the wiring mutation: transplant a
// handler and the WRONG spy fires.
function makeSpies() {
  return {
    sign: vi.fn(async () => ({ bytes: new Uint8Array([1]) })),
    vaultWrite: vi.fn(async () => {}),
    vaultRead: vi.fn(async () => ({ kind: 'record' })),
    notify: vi.fn(async () => {}),
    httpFetch: vi.fn(async () => ({})),
    pendingPut: vi.fn(async () => {}),
    clockNow: vi.fn(() => 0),
  }
}
type Spies = ReturnType<typeof makeSpies>

function makeBuildBundle(s: Spies) {
  const crypto = { sign: s.sign, deriveForOrigin: vi.fn(async () => ({ kind: 'derived' })) }
  const bundles: Record<CtxBundleTag, unknown> = {
    untrusted: { notify: { show: s.notify }, http: { fetch: s.httpFetch } },
    signing: { crypto, vault: { read: s.vaultRead } },
    consent: {
      pending: { put: s.pendingPut, get: vi.fn(async () => null), markConsumed: vi.fn(async () => {}) },
      notify: { show: s.notify },
      clock: { now: s.clockNow },
    },
    keyAdmin: { vault: { read: s.vaultRead, write: s.vaultWrite }, crypto },
  }
  // A generic `<T>(tag:T)=>CtxFor<T>` signature is not satisfiable by a Mock, so the
  // impl is typed loosely and cast where it enters `DispatchDeps` (in `deps()`).
  return vi.fn((tag: CtxBundleTag): unknown => bundles[tag])
}

// ── fixture routes (precise tags → construction-site confinement) ─────────────
const objPayload = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') throw new Error('bad shape')
  return raw as never
}

function signingRoute(over: Partial<Route<'WALLET_LINK', 'signing'>> = {}): Route<'WALLET_LINK', 'signing'> {
  return {
    bundle: 'signing',
    allowFrom: { origins: [GOOD], senders: ['web'] },
    validate: objPayload,
    async handle(_p, ctx) {
      await ctx.crypto.sign(new Uint8Array())
      return { signed: true }
    },
    ...over,
  }
}

function keyAdminRoute(over: Partial<Route<'DID_SYNC', 'keyAdmin'>> = {}): Route<'DID_SYNC', 'keyAdmin'> {
  return {
    bundle: 'keyAdmin',
    allowFrom: { origins: [GOOD], senders: ['web'] },
    validate: objPayload,
    async handle(_p, ctx) {
      await ctx.vault.write({ kind: 'rec' })
      return { synced: true }
    },
    ...over,
  }
}

// Build a full-shaped registry from the fail-closed stubs, overriding the keys
// under test. Untouched keys keep MESSAGE_ROUTES' throwing stubs.
function registry(over: Partial<{ [K in MessageType]: Route<K> }>): { [K in MessageType]: Route<K> } {
  return { ...MESSAGE_ROUTES, ...over }
}

const webSender = () => ({ origin: GOOD, kind: 'web' as const })

function deps(over: Partial<DispatchDeps> = {}): { d: DispatchDeps; s: Spies; buildBundle: ReturnType<typeof makeBuildBundle> } {
  const s = makeSpies()
  const buildBundle = makeBuildBundle(s)
  const d: DispatchDeps = {
    buildBundle: buildBundle as unknown as DispatchDeps['buildBundle'],
    routes: registry({ WALLET_LINK: signingRoute(), DID_SYNC: keyAdminRoute() }),
    resolveSender: webSender,
    ...over,
  }
  return { d, s, buildBundle }
}

const msg = (type: string, payload: unknown = {}, id?: string): InboundMessage => ({ type, payload, id })

describe('dispatch — happy path + wiring (mutation i)', () => {
  it('runs the WALLET_LINK handler → the signing spy fires, keyAdmin spy does not', async () => {
    const { d, s } = deps()
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: true, data: { signed: true } })
    expect(s.sign).toHaveBeenCalledTimes(1) // ← referent: identity of the handler
    expect(s.vaultWrite).not.toHaveBeenCalled()
  })

  it('runs the DID_SYNC handler → the keyAdmin spy fires, signing spy does not', async () => {
    const { d, s } = deps()
    const res = await dispatch(msg('DID_SYNC'), {}, d)
    expect(res).toEqual({ ok: true, data: { synced: true } })
    expect(s.vaultWrite).toHaveBeenCalledTimes(1)
    expect(s.sign).not.toHaveBeenCalled()
  })
})

describe('dispatch — stage 2 unknown type (fail-closed)', () => {
  it('rejects an unknown type before any effect', async () => {
    const { d, s, buildBundle } = deps()
    const res = await dispatch(msg('NOT_A_TYPE'), {}, d)
    expect(res).toEqual({ ok: false, error: 'unknown-type' })
    expect(buildBundle).not.toHaveBeenCalled()
    expect(s.sign).not.toHaveBeenCalled()
  })

  it('rejects a prototype-pollution key (__proto__) as unknown, not as a route', async () => {
    const { d } = deps()
    const res = await dispatch(msg('__proto__'), {}, d)
    expect(res).toEqual({ ok: false, error: 'unknown-type' })
  })
})

describe('dispatch — stage 3 authority (mutation iii)', () => {
  it('rejects a well-formed payload from a disallowed origin, before effect', async () => {
    const { d, s, buildBundle } = deps({ resolveSender: () => ({ origin: 'https://evil.example', kind: 'web' }) })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'forbidden-origin' })
    expect(buildBundle).not.toHaveBeenCalled()
    expect(s.sign).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: the same payload from an allowed sender succeeds', async () => {
    const { d, s } = deps() // allowed sender
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: true, data: { signed: true } })
    expect(s.sign).toHaveBeenCalledTimes(1)
  })

  it('rejects an allowed origin but disallowed sender kind', async () => {
    const { d } = deps({ resolveSender: () => ({ origin: GOOD, kind: 'extension' }) })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'forbidden-sender' })
  })

  it('FAIL-OPEN GUARD: a null (unresolvable) origin is rejected, never treated as empty-match', async () => {
    const { d } = deps({ resolveSender: () => ({ origin: null, kind: 'web' }) })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'forbidden-origin' })
  })

  it('the fail-closed default (empty allowFrom stub) admits zero senders', async () => {
    // CREDENTIAL_OFFER keeps MESSAGE_ROUTES' empty {origins:[],senders:[]} stub.
    const { d } = deps()
    const res = await dispatch(msg('CREDENTIAL_OFFER'), {}, d)
    expect(res).toEqual({ ok: false, error: 'forbidden-origin' })
  })

  it('NEVER trusts payload.origin: a good payload.origin cannot rescue a bad sender', async () => {
    const { d, s } = deps({ resolveSender: () => ({ origin: null, kind: 'web' }) })
    const res = await dispatch(
      msg('WALLET_LINK', { origin: GOOD }), // attacker-supplied good origin in payload
      {},
      d,
    )
    expect(res).toEqual({ ok: false, error: 'forbidden-origin' })
    expect(s.sign).not.toHaveBeenCalled()
  })
})

describe('dispatch — stage 4 shape (mutation ii)', () => {
  it('rejects a malformed payload before effect (validate threw)', async () => {
    const { d, s, buildBundle } = deps()
    const res = await dispatch(msg('WALLET_LINK', 'not-an-object'), {}, d)
    expect(res).toEqual({ ok: false, error: 'invalid-payload' })
    expect(buildBundle).not.toHaveBeenCalled() // reject BEFORE effect
    expect(s.sign).not.toHaveBeenCalled()
  })

  it('MUTATION ii referent: a pass-through validate (z.any) would let the handler run on garbage', async () => {
    // Simulate the mutation: swap validate to accept anything.
    const passthrough = signingRoute({ validate: (raw) => raw as never })
    const { d, s } = deps({ routes: registry({ WALLET_LINK: passthrough }) })
    const res = await dispatch(msg('WALLET_LINK', 'not-an-object'), {}, d)
    // This documents the mutated behavior the guard test above forbids: handler fires.
    expect(res).toEqual({ ok: true, data: { signed: true } })
    expect(s.sign).toHaveBeenCalledTimes(1)
  })
})

describe('dispatch — stage 6 verifyPeer seam', () => {
  it('present + returns false → peer-verification-failed, handler not run', async () => {
    const { d, s } = deps({
      routes: registry({ WALLET_LINK: signingRoute({ verifyPeer: async () => false }) }),
    })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'peer-verification-failed' })
    expect(s.sign).not.toHaveBeenCalled()
  })

  it('present + throws → peer-verification-failed', async () => {
    const { d } = deps({
      routes: registry({ WALLET_LINK: signingRoute({ verifyPeer: async () => { throw new Error('x') } }) }),
    })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'peer-verification-failed' })
  })

  it('present + returns true → proceeds to handle', async () => {
    const { d, s } = deps({
      routes: registry({ WALLET_LINK: signingRoute({ verifyPeer: async () => true }) }),
    })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: true, data: { signed: true } })
    expect(s.sign).toHaveBeenCalledTimes(1)
  })
})

describe('dispatch — stage 7 handler error', () => {
  it('a throwing handler → handler-error (buildBundle already ran)', async () => {
    const { d, buildBundle } = deps({
      routes: registry({ WALLET_LINK: signingRoute({ handle: async () => { throw new Error('boom') } }) }),
    })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'handler-error' })
    expect(buildBundle).toHaveBeenCalledTimes(1) // stage 5 ran before stage 7
  })
})

describe('dispatch — FIXED ORDER (each adjacent boundary is a mutation target)', () => {
  it('authority BEFORE validate: disallowed sender + would-throw validate → forbidden-origin', async () => {
    const throwingValidate = signingRoute({ validate: () => { throw new Error('bad') } })
    const { d } = deps({
      routes: registry({ WALLET_LINK: throwingValidate }),
      resolveSender: () => ({ origin: 'https://evil.example', kind: 'web' }),
    })
    const res = await dispatch(msg('WALLET_LINK', 'garbage'), {}, d)
    expect(res).toEqual({ ok: false, error: 'forbidden-origin' }) // NOT invalid-payload
  })

  it('validate BEFORE verifyPeer: throwing validate + would-fail verifyPeer → invalid-payload', async () => {
    const r = signingRoute({
      validate: () => { throw new Error('bad') },
      verifyPeer: async () => false,
    })
    const { d } = deps({ routes: registry({ WALLET_LINK: r }) })
    const res = await dispatch(msg('WALLET_LINK', 'garbage'), {}, d)
    expect(res).toEqual({ ok: false, error: 'invalid-payload' }) // NOT peer-verification-failed
  })

  it('verifyPeer BEFORE handle: failing verifyPeer + would-throw handle → peer-verification-failed, handle not run', async () => {
    const r = signingRoute({
      verifyPeer: async () => false,
      handle: async () => { throw new Error('should not run') },
    })
    const { d, s } = deps({ routes: registry({ WALLET_LINK: r }) })
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: false, error: 'peer-verification-failed' }) // NOT handler-error
    expect(s.sign).not.toHaveBeenCalled()
  })
})

describe('dispatch — stage 8 idempotency seam (mutation iv: replay)', () => {
  function replayPending() {
    let consumed = false
    return {
      get: vi.fn(async (id: string) => ({ id, consumed, payload: {} })),
      markConsumed: vi.fn(async () => { consumed = true }),
      put: vi.fn(async () => {}),
      takePending: vi.fn(async () => null), // dispatch doesn't use it; present to satisfy the port
      claimForProcessing: vi.fn(async () => ({ status: 'missing' as const })), // ditto (Story 1.16)
    }
  }

  it('a replayed (already-consumed) request fires the handler exactly ONCE across two calls', async () => {
    const pending = replayPending()
    const { d, s } = deps({ pending })
    const m = msg('WALLET_LINK', {}, 'req-1')
    const first = await dispatch(m, {}, d)
    const second = await dispatch(m, {}, d)
    expect(first).toEqual({ ok: true, data: { signed: true } })
    expect(second).toEqual({ ok: false, error: 'replayed' })
    expect(s.sign).toHaveBeenCalledTimes(1) // ← referent: NOT the return value
  })

  it('port-dropped: if the pending store throws on read, fail-closed (handler not run)', async () => {
    const pending = {
      get: vi.fn(async () => { throw new Error('store down') }),
      markConsumed: vi.fn(async () => {}),
      put: vi.fn(async () => {}),
      takePending: vi.fn(async () => null),
      claimForProcessing: vi.fn(async () => ({ status: 'missing' as const })),
    }
    const { d, s } = deps({ pending })
    const res = await dispatch(msg('WALLET_LINK', {}, 'req-2'), {}, d)
    expect(res).toEqual({ ok: false, error: 'port-dropped' })
    expect(s.sign).not.toHaveBeenCalled()
  })

  it('no id / no pending → the replay logic is inert (handler runs normally)', async () => {
    const { d, s } = deps() // no pending injected
    const res = await dispatch(msg('WALLET_LINK'), {}, d)
    expect(res).toEqual({ ok: true, data: { signed: true } })
    expect(s.sign).toHaveBeenCalledTimes(1)
  })
})

describe('dispatch — purity (not the pipeline proof, just the MV3/CSP guard)', () => {
  it('the module imports with no `chrome.*` present at import time', async () => {
    const g = globalThis as { chrome?: unknown }
    const had = 'chrome' in g
    const saved = g.chrome
    delete g.chrome
    try {
      await expect(import('./dispatch')).resolves.toBeDefined()
    } finally {
      if (had) g.chrome = saved
    }
  })
})
