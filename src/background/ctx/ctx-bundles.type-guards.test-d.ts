/**
 * Story 1.4 — Channel A: compile-time tripwires for capability confinement (AD-1/2/3/4).
 * No runtime code; Vitest never runs this file. Type-checked by `vue-tsc -b --noEmit`.
 *
 * Each `@ts-expect-error` asserts a capability a bundle must NOT expose. If a bundle
 * ever widens so the capability becomes nameable, the suppressed error disappears,
 * the suppression goes unused, and `vue-tsc` reds on it — a self-guarding tripwire.
 *
 * Mutations watched red then restored during the build:
 *   - add `vault` to `UntrustedCtx`                → AC2 red
 *   - retype `SigningCtx.vault` to full `Vault`    → AC3 red (the load-bearing one)
 *   - add `counterpartyDid` to any bundle          → AC4 red
 *   - add a `getPrivateKey` to the vault           → AD-2 type-slice red
 *   - drop `consumed` from `PendingRow`            → AC1 presence red
 */
import type { UntrustedCtx, SigningCtx, ConsentCtx, KeyAdminCtx } from './ctx-bundles'
import type { PendingRow } from '@/background/ports/ports'
import { normalizeOrigin } from '@/utils/origin'

declare const u: UntrustedCtx
declare const s: SigningCtx
declare const c: ConsentCtx
declare const k: KeyAdminCtx

// ── AC2: the untrusted tier cannot even NAME a key/sign capability.
// @ts-expect-error — UntrustedCtx has no vault capability
void u.vault
// @ts-expect-error — UntrustedCtx has no crypto capability
void u.crypto
void u.notify // positive control — notify IS in the bundle

// ── AC3 (LOAD-BEARING): SigningCtx.vault is read-only (`VaultRead`) — no write.
void s.vault.read() // positive control — read allowed
// @ts-expect-error — SigningCtx.vault is VaultRead; it cannot mutate the vault
void s.vault.write({ kind: 'x' })
void k.vault.write({ kind: 'x' }) // positive control — KeyAdmin has the full Vault

// ── Story 1.11: the SIGNING tier's concrete store is READ-ONLY.
void s.store.read() // positive control — signing reads the vault to sign
// @ts-expect-error — SigningCtx.store has no write (a signing handler cannot mutate the vault)
void s.store.write({ kind: 'x' })
// @ts-expect-error — SigningCtx.store has no syncPublic (mirroring is KeyAdmin's, keys-never-mirrored)
void s.store.syncPublic({ kind: 'x' })

// ── AD-2 type-slice: the vault exposes NO raw-private-key getter.
// @ts-expect-error — the vault never hands out a bare private key (AD-2)
void k.vault.getPrivateKey()

// ── AC4: counterpartyDid is router-owned — absent from EVERY bundle.
// @ts-expect-error — counterpartyDid is router-owned, not in UntrustedCtx
void u.counterpartyDid
// @ts-expect-error — counterpartyDid is router-owned, not in SigningCtx
void s.counterpartyDid
// @ts-expect-error — counterpartyDid is router-owned, not in ConsentCtx
void c.counterpartyDid
// @ts-expect-error — counterpartyDid is router-owned, not in KeyAdminCtx
void k.counterpartyDid

// ── AC1 (AD-15→AD-11a tie-in): deriveForOrigin requires a CanonicalOrigin.
// @ts-expect-error — a raw string is not a CanonicalOrigin; derivation must use the normalized form
void s.crypto.deriveForOrigin('https://x.com')
const canon = normalizeOrigin('https://x.com')
if (canon) void s.crypto.deriveForOrigin(canon) // positive control

// ── AC5 (AD-11c): SigningCtx.crypto and KeyAdminCtx.crypto are the SAME `Crypto`.
// If KeyAdminCtx.crypto is ever widened to a superset (e.g. an ungated `signRaw`),
// SigningCtx.crypto is no longer assignable to it and this reddens.
const _sameCrypto: (a: SigningCtx['crypto']) => KeyAdminCtx['crypto'] = (a) => a
void _sameCrypto

// ── AC1: `PendingRow` owns `id` + `consumed` (AD-6 idempotency referent).
const _rowId: string = ({} as PendingRow).id
void _rowId
const _rowConsumed: boolean = ({} as PendingRow).consumed
void _rowConsumed
