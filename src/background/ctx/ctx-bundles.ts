/**
 * Story 1.4 — the four capability-scoped `ctx` bundles (AD-3). Each handler
 * receives EXACTLY its bundle; a handler in `UntrustedCtx` cannot even *name* a
 * vault/crypto capability (a compile error — see `ctx-bundles.type-guards.test-d.ts`).
 *
 * Composed from the port catalog. Two invariants are load-bearing:
 *   - `SigningCtx.vault` is `VaultRead` (read-only); only `KeyAdminCtx.vault` is
 *     the full `Vault` (write). Widening the former is the privilege-escalation
 *     the AC3 fixture guards.
 *   - `SigningCtx.crypto` and `KeyAdminCtx.crypto` are the SAME `Crypto` type —
 *     one `sign`, no ungated alternative (AD-11c).
 *
 * `counterpartyDid` is in NO bundle (router-owned, AD-9). Shim-first (AD-12):
 * these types are declared, not consumed — the router builds/injects a bundle per
 * route in Story 1.5, handlers are extracted onto them in 1.9+.
 */
import type {
  VaultRead,
  Vault,
  Crypto,
  Pending,
  Notify,
  Http,
  Clock,
} from '@/background/ports/ports'

/** Parse/notify tier — no key, no sign, no vault. */
export interface UntrustedCtx {
  notify: Notify
  http: Http
}

/** Signing tier — read key material to sign; MUST NOT mutate the vault. */
export interface SigningCtx {
  crypto: Crypto
  vault: VaultRead
}

/** Consent/approval tier. */
export interface ConsentCtx {
  pending: Pending
  notify: Notify
  clock: Clock
}

/** Key-lifecycle tier — full vault (rotate/backup/restore, + Shamir import). */
export interface KeyAdminCtx {
  vault: Vault
  crypto: Crypto
}
