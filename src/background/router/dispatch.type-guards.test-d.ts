/**
 * Story 1.5 — compile-time channel for the ctx tightening (AD-3 confinement).
 *
 * These `@ts-expect-error` lines are PERMANENT tripwires: each marks a guaranteed
 * compile error. If a future edit makes the error vanish (e.g. widens a bundle),
 * the suppression goes unused → `TS2578` → `vue-tsc -b` reds. Self-guarding.
 *
 * This is a SEPARATE channel from `dispatch.spec.ts` (runtime). It proves the
 * *shape* claims the runtime spies cannot: that a route's handler receives exactly
 * `CtxFor<Tag>` and cannot name another tier's capability.
 */
import type { Route, CtxFor, AnyCtx } from './route'
import type { SigningCtx, KeyAdminCtx, UntrustedCtx } from '@/background/ctx/ctx-bundles'

// ── CtxFor maps each tag to its precise bundle ────────────────────────────────
const _signing: CtxFor<'signing'> = null as unknown as SigningCtx
const _keyAdmin: CtxFor<'keyAdmin'> = null as unknown as KeyAdminCtx
const _untrusted: CtxFor<'untrusted'> = null as unknown as UntrustedCtx
void _signing
void _keyAdmin
void _untrusted

// A signing ctx is NOT a keyAdmin ctx (no write on its vault) — the escalation
// the AC3 fixture in 1.4 guards, restated at the route boundary.
// @ts-expect-error — SigningCtx.vault is VaultRead (no write); not assignable to KeyAdminCtx.
const _notEscalatable: CtxFor<'keyAdmin'> = null as unknown as SigningCtx
void _notEscalatable

// ── Construction-site confinement: a signing route's handler body ─────────────
// The handler receives SigningCtx: `ctx.crypto.sign` is nameable…
const _okSigning: Route<'SIGN_REQUEST', 'signing'> = {
  bundle: 'signing',
  allowFrom: { origins: [], senders: [] },
  validate: (raw) => raw as never,
  async handle(_p, ctx) {
    await ctx.crypto.sign(new Uint8Array())
    return { ok: true } as never
  },
}
void _okSigning

// …but `ctx.vault.write` (a KeyAdmin-only capability) is NOT nameable on SigningCtx.
const _confinedSigning: Route<'SIGN_REQUEST', 'signing'> = {
  bundle: 'signing',
  allowFrom: { origins: [], senders: [] },
  validate: (raw) => raw as never,
  async handle(_p, ctx) {
    // @ts-expect-error — `write` does not exist on SigningCtx.vault (VaultRead).
    await ctx.vault.write({ kind: 'x' })
    return { ok: true } as never
  },
}
void _confinedSigning

// ── AnyCtx cannot name a capability without narrowing (why routes fix their tag) ─
declare const anyCtx: AnyCtx
// @ts-expect-error — `crypto` is absent on UntrustedCtx/ConsentCtx arms of the union.
void anyCtx.crypto
