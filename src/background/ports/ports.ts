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
