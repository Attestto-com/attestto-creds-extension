/**
 * Story 1.4 — the port catalog (AD-4): the effectful/stateful seams a handler
 * reaches only through its injected `ctx` bundle. Pure functions (`parseSdJwt`,
 * `normalizeOrigin`, `publicJwkToDid`, `canonicalAuthMessage`, `split2of3`, …) are
 * **plain imports, never ports** (AD-4) — that invariant is design-review prose,
 * deliberately NOT a brittle "exactly these keys" type test (it would redden on
 * legitimate growth; logic party 2026-08-08 cut it).
 *
 * Shim-first (AD-12): these are TYPE interfaces only — declared, not consumed. No
 * adapter is wired and no handler is extracted; the legacy switch still dispatches.
 * Real method surface arrives with the adapters in Story 1.5+. Most ports are
 * intentionally near-empty; only the security-load-bearing shapes are specified.
 *
 * AD-2 type-slice (Story 1.4 does this part; runtime "no module-scope key" is
 * 1.9+/1.13): **no port method returns a bare private key.** `crypto.sign` signs
 * internally and returns a `Signature`; `vault.read` returns an opaque
 * `VaultRecord`. A handler cannot even *type* `const k = ctx.vault.getPrivateKey()`
 * because no such method exists.
 */
import type { CanonicalOrigin } from '@/utils/origin'
import type { VaultData } from '@/stores/wallet'

/**
 * An opaque decrypted vault record. Deliberately NOT a raw private key handed to
 * the caller — the vault never yields a bare JWK (AD-2 type-slice). The concrete
 * shape is Story 1.5's adapter concern.
 */
export interface VaultRecord {
  readonly kind: string
}

/** Read surface of the vault. Given to `SigningCtx` — read key material to sign, never mutate. */
export interface VaultRead {
  read(): Promise<VaultRecord>
}

/** Full vault. Given only to `KeyAdminCtx` (rotate/backup/restore). */
export interface Vault extends VaultRead {
  write(record: VaultRecord): Promise<void>
}

/** Public (unencrypted) mirror the popup reads without an unlock. */
export interface PublicVault {
  readPublic(): Promise<VaultRecord>
}

/** An opaque signature. The private key that produced it never leaves `crypto`. */
export interface Signature {
  readonly bytes: Uint8Array
}

/**
 * The ONE signing primitive (AD-11c) plus per-origin derivation. Referenced by
 * BOTH `SigningCtx` and `KeyAdminCtx` as the *same* type — so no second/ungated
 * `sign` is expressible. `sign` returns a `Signature`, never the key (AD-2). The
 * WebAuthn liveness gate lives *inside* `sign` — Story 1.6 fills it.
 */
export interface Crypto {
  sign(payload: Uint8Array): Promise<Signature>
  /** Pairwise `did:jwk` derivation, keyed on a canonical origin (AD-11a / AD-15). */
  deriveForOrigin(origin: CanonicalOrigin): Promise<VaultRecord>
}

/**
 * A pending-request row. The `pending` port OWNS this schema including `id` and
 * `consumed` (AD-4), so AD-6's idempotency wrap (Story 1.5) reads/sets a concrete
 * field and cannot silently no-op (the vacuous-green trap AD-13 forbids).
 */
export interface PendingRow {
  id: string
  consumed: boolean
  payload: unknown
}

/** Storage-backed pending-request port (survives service-worker restart). */
export interface Pending {
  put(row: PendingRow): Promise<void>
  get(id: string): Promise<PendingRow | null>
  markConsumed(id: string): Promise<void>
  /**
   * ATOMIC consume (Story 1.13, ConsentCtx-facing — distinct from the router's
   * `consumed`-idempotency, which `takePending` MUST NOT touch; single-writer on
   * `consumed` stays the router, AD-6 stage 8). Returns the row and removes it in
   * one indivisible step, or `null` if it was already taken/absent. Async-returning
   * now (Story 1.15 backs it with `chrome.storage.session`, inherently async) so the
   * five awaited APPROVE call-sites don't re-open on a later sync→async flip. The
   * atomicity is load-bearing: two concurrent APPROVEs for one `id` must NOT both win
   * (double-sign) — so this is `get`-and-`delete` with NO `await` between.
   */
  takePending(id: string): Promise<PendingRow | null>
}

/** OS notification surface. */
export interface Notify {
  show(message: string): Promise<void>
}

/** A single notification button. */
export interface NotificationButton {
  title: string
}

/** Rich OS-notification options — mirrors `chrome.notifications.create`'s option bag. */
export interface NotificationOptions {
  type: string
  iconUrl: string
  title: string
  message: string
  buttons?: NotificationButton[]
  requireInteraction?: boolean
}

/** Rich notification surface (create by id). Story 1.9 gave untrusted this real port. */
export interface Notifications {
  create(id: string, options: NotificationOptions): Promise<void>
}

/**
 * Extension-runtime surface a handler may touch: broadcast to the popup and
 * resolve a packaged asset URL. Thin mirrors of `chrome.runtime.sendMessage` /
 * `getURL` — the real adapter is the composition root (Story 1.13).
 */
export interface Runtime {
  sendMessage(message: unknown): Promise<void>
  getURL(path: string): string
}

/** Outbound HTTP. */
export interface Http {
  fetch(url: string, init?: unknown): Promise<unknown>
}

/** Wall clock (injectable so consent-expiry logic is testable). */
export interface Clock {
  now(): number
}

/** Per-origin trust + pin. Keyed on a canonical origin (AD-15). */
export interface Origins {
  isTrusted(origin: CanonicalOrigin): Promise<boolean>
}

/** Message a specific tab. */
export interface Tabs {
  sendToTab(tabId: number, message: unknown): Promise<void>
}

/**
 * Concrete KeyAdmin vault store (Story 1.10, first KeyAdmin extraction). The
 * abstract `Vault`/`VaultRecord` seams above stay for the confinement type-guards;
 * a key-lifecycle handler needs the *real* record — it persists generated key
 * material and mirrors to the public vault. `read` returns the whole `VaultData`
 * (the opaque record AD-2 permits — there is NO `getPrivateKey()` accessor and the
 * handler derives only the *public* key from it, never signs). `syncPublic` is the
 * Story-1.7 strict-strip: the ONLY sanctioned path to the public mirror, so a key
 * cannot ride to disk (keys-never-mirrored).
 */
export interface KeyVaultStore {
  read(): Promise<VaultData | null>
  write(vault: VaultData): Promise<void>
  syncPublic(vault: VaultData): Promise<void>
}

/**
 * Read-only vault access for the SIGNING tier (Story 1.11). A signing handler
 * reads key material to sign and reads `holderDid`/`did` to label the response,
 * but MUST NOT mutate the vault — there is no `write`/`syncPublic` here (the
 * confinement type-guard asserts their absence). Returns the whole `VaultData`
 * (the opaque record AD-2 permits: there is NO `getPrivateKey()` accessor; the
 * handler derives only the PUBLIC key fields from it and never calls `subtle.sign`
 * itself — the gated `crypto.sign` primitive is the only signing path). `null`
 * when the vault is locked.
 */
export interface SigningVaultStore {
  read(): Promise<VaultData | null>
}

/**
 * Narrow key-provisioning capability for the two SIGNING handlers that must mint key
 * material as a side effect (APDF's lazy Ed25519 key; AUTH's per-site DID). Story
 * 1.11, F1 (Vex): a signing handler that provisions a key names EXACTLY this — not a
 * generic `vault.write`. The methods return only PUBLIC material (a `publicKeyB64` /
 * a `did`), **never the private JWK** (AD-2): the private key stays inside the
 * adapter, which also owns the write+mirror (so keys-never-mirrored is the adapter's
 * `toPublicVault` strip, not the handler's concern). `null` when the vault is locked.
 */
export interface Provisioning {
  /** Lazily generate/load the Ed25519 signing key; returns its public key (base64 raw). */
  provisionEd25519(): Promise<{ publicKeyB64: string } | null>
  /**
   * Find-or-create the PAIRWISE per-origin DID (write + mirror inside the adapter),
   * returning its `did` + public JWK only — never the private key. The adapter also
   * binds the gated signer to this per-site key. `null` when the vault is locked or
   * the origin is invalid.
   */
  provisionSiteDid(origin: string): Promise<{ did: string; publicKeyJwk: JsonWebKey } | null>
}

/**
 * Pin a site (record the sign-in-as-trust decision). Story 1.11, F1: AUTH's SECOND
 * write is a distinct capability from key provisioning — a signing handler that pins
 * names exactly this, not a generic `vault.write`. Best-effort at the call site.
 */
export interface SitePin {
  pin(host: string): Promise<void>
}

/**
 * P-256 keypair generation (a KeyAdmin capability, distinct from AD-11c's single
 * `sign` primitive — generating an identity key is not signing). Returns both JWKs;
 * the private JWK is persisted into the vault record, the public JWK is field-
 * stripped for the response. Wraps `crypto.subtle.generateKey` + `exportKey`.
 */
export interface KeyGen {
  generateP256(): Promise<{ privateKeyJwk: JsonWebKey; publicKeyJwk: JsonWebKey }>
}

/** Scheduled alarms (e.g. idle auto-lock, Story 1.14). */
export interface Alarms {
  schedule(name: string, whenMs: number): Promise<void>
}

/**
 * Counterparty-DID resolution + method-verified control-of-key (AD-9). This port
 * is **router-owned**: consumed only by the router's stage-6 verify step, and
 * present in NO handler bundle (a handler that could name it could hand-roll a
 * weaker counterparty check — the resolve-then-trust class of bug). Full surface
 * is Epic 2.
 */
export interface CounterpartyDid {
  resolve(did: string, opts: { allowMethods: readonly string[] }): Promise<unknown>
}
