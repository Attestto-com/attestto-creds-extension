# Web-Message Boundary Guard — Design

**Date:** 2026-07-19
**Closes:** SOC-2, SOC-3, SOC-8, SOC-9 (SOC-1 workspace audit, remediation item #1)
**Repo:** attestto-creds-extension

## Problem

`credential-api.content.ts` runs on `https://*/*` and forwards sensitive message
types to the background service worker. The router (`background.ts`) dispatches
`DID_SYNC`, `KEY_ROTATE`, `KEY_BACKUP`, `KEY_RESTORE` to their handlers using only
`sender.tab?.id` for response routing. It never inspects the sender origin and
never opens an approval window. The single gate is `readVault()` returning
non-null (vault unlocked). Within any unlocked window (auto-lock = 60s), any HTTPS
tab can:

- `KEY_BACKUP` → receive all 3 Shamir shares of the signing key (SOC-2, CRITICAL)
- `KEY_RESTORE` → overwrite `vault.privateKeyJwk` with attacker key (SOC-3, CRITICAL)
- `KEY_ROTATE` → destroy the signing key + reset `did` (SOC-8, HIGH)
- `DID_SYNC` → inject `holderDid`/`verificationMethod`, later asserted in
  SIGN/PAYMENT/AUTH responses (SOC-9, HIGH)

**Root trust error:** the code keys decisions off page-supplied `payload.origin`.
The only trustworthy origin is `sender.origin` (Chrome-populated, unspoofable).

## Design

Two classes with different correct behavior.

### Class 1 — key-management ops (BACKUP / RESTORE / ROTATE) → hard-reject from web

Decision (approved 2026-07-19): **Options-UI only.** No legitimate page-initiated
path. Fix:

1. Delete the `ATTESTTO_KEY_BACKUP`, `ATTESTTO_KEY_RESTORE`, `ATTESTTO_KEY_ROTATE`
   branches from `credential-api.content.ts` — removes the page entry point.
2. In the router, guard the `KEY_BACKUP` / `KEY_RESTORE` / `KEY_ROTATE` cases with
   `isExtensionSender(sender)`. A web tab always has `sender.tab` set → rejected.
   Only the extension's own pages (popup / options / approval) pass.
3. On rejection, respond `{ ok: false, error: 'forbidden_sender' }` and log; do not
   invoke the handler.

Backup/restore/rotate remain reachable only from the Options UI (already
extension-origin). No allowlist required — the ops leave the web surface entirely.

### Class 2 — DID_SYNC → allowlist + trust-on-first-use approval

Legitimate platform→extension flow; cannot hard-reject. Gate on the trusted
sender origin:

1. Compute the trusted sender origin via `getSenderOrigin(sender)`.
2. If origin ∈ platform allowlist (`platformOrigins()` — `PLATFORM_URL` origin +
   `localhost` / `127.0.0.1` in dev + future tenant subdomains) → proceed.
3. Else if `isOriginTrusted(origin)` → proceed (previously user-approved).
4. Else → **fail closed**: reject with `origin_not_authorized`, do not mutate the
   vault. (Implemented.)

**Deferred to follow-up (no current origin needs it):** trust-on-first-use
approval window for *unknown* origins. The platform is allowlisted, so the real
sync flow works without any approval UI; building a DID-sync-specific
approval.html branch is its own reviewed task. Until then unknown origins simply
fail closed — strictly safer than an approval fallback.

**Remaining SOC-9 task (NOT in this change): stop treating `holderDid` as
authoritative for signing.** SIGN/PAYMENT/AUTH responses
(`background.ts:1638/1973/2071`) still assert the synced `holderDid`. Gating the
sync means only an authorized origin can set it, which substantially closes the
injection vector, but the durable fix is to assert the vault's key-derived DID
(or a user-selected DID) rather than an arbitrary synced value. Tracked as a
follow-up task on SOC-9.

### Shared chokepoint — `src/utils/message-guard.ts`

Pure, unit-testable helpers keyed off the trusted `sender`, never `payload`:

```ts
// sender.url of an extension page starts with chrome.runtime.getURL('')
export function isExtensionSender(sender: chrome.runtime.MessageSender): boolean
// trusted origin: web tabs → sender.origin; extension pages → the extension origin
export function getSenderOrigin(sender: chrome.runtime.MessageSender): string | null
```

`src/utils/platform-origins.ts`:

```ts
export function platformOrigins(): string[]        // allowlist
export function isPlatformOrigin(origin: string | null): boolean
```

## Test plan

Follows the repo's `src/utils/*.spec.ts` convention (see `trusted-origins.spec.ts`).

- `message-guard.spec.ts`: extension-page sender → `isExtensionSender` true;
  web-tab sender (has `sender.tab`) → false; `getSenderOrigin` returns
  `sender.origin` for a tab, the extension origin for an extension page, `null`
  for malformed input; page-supplied `payload.origin` is ignored.
- `platform-origins.spec.ts`: `PLATFORM_URL` origin allowed; arbitrary HTTPS
  origin rejected; localhost allowed only in dev.

Router wiring is covered by the guard-unit tests plus manual verification
(browser) that a crafted page can no longer trigger the four ops — the MV3 SW
itself has no existing spec harness, matching the repo's current structure.

## Out of scope

- SOC-13 (Medium/Low hardening backlog) — `web_accessible_resources` breadth,
  dep audit, auto-lock gesture. Do after this lands; the guard's
  `isPlatformOrigin` helper is the defense-in-depth primitive SOC-13 needs.

## Branch / process

- New branch off `develop`: `feat/soc-web-message-guard` (do NOT stack on
  `feat/popup-polish`).
- One PR closing SOC-2/3/8/9 off a single guard commit series; keep the four
  tickets for audit provenance.
