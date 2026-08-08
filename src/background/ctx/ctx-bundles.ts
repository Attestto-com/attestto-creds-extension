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
  Notifications,
  Runtime,
  KeyVaultStore,
  KeyGen,
  SigningVaultStore,
} from '@/background/ports/ports'

/**
 * Parse/notify tier — no key, no sign, no vault. `notifications` + `runtime` are
 * the real ports the first extracted untrusted handler (`DIDCOMM_INBOUND`, Story
 * 1.9) uses: raise an OS notification and broadcast to the popup.
 */
export interface UntrustedCtx {
  notify: Notify
  http: Http
  notifications: Notifications
  runtime: Runtime
}

/**
 * Signing tier — read key material to sign; MUST NOT mutate the vault.
 *
 * `crypto`/`vault` are the abstract confinement seams (the type-guards assert the
 * read-only `VaultRead` and the shared-`Crypto` invariant). The concrete ports the
 * first extracted signing handler (`SIGN_DOCUMENT_APPROVE`, Story 1.11) uses:
 * `store` (real `VaultData` READ — no write/syncPublic, guarded) and `clock`
 * (injectable signing timestamp). Every signature goes through `crypto.sign`, the
 * single gated primitive (AD-11c); the handler never touches `subtle.sign`.
 */
export interface SigningCtx {
  crypto: Crypto
  vault: VaultRead
  store: SigningVaultStore
  clock: Clock
}

/** Consent/approval tier. */
export interface ConsentCtx {
  pending: Pending
  notify: Notify
  clock: Clock
}

/**
 * Key-lifecycle tier — full vault (rotate/backup/restore, + Shamir import).
 *
 * `vault`/`crypto` are the abstract confinement seams (the type-guards assert
 * KeyAdmin's full-`Vault` write and the shared-`Crypto` invariant). The concrete
 * ports — `store` (real `VaultData` read/write/public-mirror), `keygen` (identity
 * keypair generation), `clock` (injectable `syncedAt`) — are the real surface the
 * first extracted KeyAdmin handler (`DID_SYNC`, Story 1.10) uses.
 */
export interface KeyAdminCtx {
  vault: Vault
  crypto: Crypto
  store: KeyVaultStore
  keygen: KeyGen
  clock: Clock
}
