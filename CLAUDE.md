# attestto-creds-extension — Operating Rules

Digital ID wallet extension (WXT + Vue 3 + MV3). See `README.md` for the wire protocol, message types, and DID/VC feature surface.

## Critical: dual-vault storage architecture

There are **two storage layers** in `chrome.storage.local`. Confusing them silently breaks the popup UI.

| Layer | Storage key | Encrypted? | Contents | Read by |
|---|---|---|---|---|
| **Public vault** | `attestto_ext_public` | No | DIDs, credentials, linked identities, Solana addr, proof requests, prepared VPs | Popup on every open (no passkey needed) |
| **Encrypted vault** | `attestto_ext_vault` | AES-256-GCM | Same fields PLUS `privateKeyJwk`, `ed25519PrivateKeyJwk` | Background SW after unlock; popup after `wallet.unlock()` |

**Rule:** any `writeVault(vault)` call in `background.ts` that mutates fields the popup needs to display MUST be followed by `syncPublicVault(vault)`. Otherwise the change lives only in the encrypted vault and the popup never sees it.

**Why:** the popup is a fresh Vue/Pinia context on every open. It can't decrypt the vault without a passkey re-prompt, so it reads from the public mirror. If the mirror isn't updated, the UI looks broken even though the encrypted data is correct. This caused the "always shows Get Started, never shows synced DIDs" bug — `handleDidSync` wrote to the encrypted vault but never mirrored.

**Audit periodically:** `grep -n "writeVault\|syncPublicVault" src/entrypoints/background.ts`. Every `writeVault` line should have a matching `syncPublicVault` nearby (or the modified fields must be private-only like `privateKeyJwk`).

## Platform integration contract

The extension **creates and owns** the first identity (Tier 1, local). The
canonical PWA is the **issuance authority** for `did:sns` Tier 2/3 identities,
which are an upgrade rather than a starting point.

**No UI links out to the platform** (removed 2026-08-09). `PLATFORM_URL` remains
in `src/config/app.ts` because `src/utils/platform-origins.ts` uses it as the
allowlist for the one origin permitted to drive `DID_SYNC` without per-origin
approval. That is a security control, not a redirect — do not delete it while the
sync channel exists.

| Surface | Domain | Purpose |
|---|---|---|
| `app.attestto.com` | `attestto-app` (public PWA) | User onboarding, DID creation, credential issuance |
| `staging.attestto.net` | CORTEX staging | **Cloudflare-Access-gated** (@attestto.com email required). NOT user-facing. Never link to this from extension UI. |
| Tenant subdomains (future) | OPTISOFT, Coastal CR, etc. | Tier 2 tenant-scoped identity allocation |

**Canonical attestto-app routes** (per `attestto-app/app/src/router/index.ts`):
- `/onboarding` — first-time identity creation
- `/lock` — returning user unlock
- `/home`, `/wallet`, `/documents`, `/verify`, `/modules`, `/settings`

There is NO `/app/register` or `/app/login`. Don't invent routes.

## Tier model (decided in [[memory: workspace strategy]])

| Tier | DID method | Issued via | Use case |
|---|---|---|---|
| 1 — local | `did:jwk` (auto-gen) | Extension, locally | **The first-run identity.** Every user starts here; upgrading to Tier 2/3 is optional |
| 2 — tenant-anchored | `did:sns:user.tenant.sol` (e.g. `did:sns:alice.optisoft.sol`) | Tenant via CORTEX subdomain allocation | KYC'd vendors (OPTISOFT, notarios) |
| 3 — user-root | `did:sns:chongkan.attestto.sol` | User claims via `attestto-app` | Cross-site portable identity, the "Sign in with Attestto" play |

> ⛔ **SNS is `subdomain.domain` — TWO levels, and that is structural.** This row
> previously read `did:sns:user.tenant.attestto.sol`, which is **impossible**:
> strip `.sol` and it is three labels, and there is no PDA to derive. Solana Name
> Service supports a root domain and one level of subdomain, full stop
> (`did-sns-spec` §7.2). **The tenant IS the domain** — a Tier 2 identity is
> `alice.optisoft`, never `alice.optisoft.attestto`. Do not "fix" this by
> proposing a spec change or asking which way it should go; there is nothing to
> decide. Corrected 2026-08-10 after this line generated the same wrong
> conclusion for a third time.

**Extension-first (confirmed 2026-08-09).** A user creates a wallet and a Tier 1
identity in the extension, with no external service. Tier 2/3 are upgrades on top,
not prerequisites.

⚠️ This paragraph previously read "Focus is Tier 2/3 — Tier 1 is not the
user-facing flow", which contradicted the decided path. That contradiction is the
likely reason the popup shipped with no setup entry point at all: the only
identity call to action linked OUT to the platform, and `LockScreenView` — the
sole caller of `wallet.setup()` — was never routed. Found by running the
extension, not by any test.

## Credential offer consent (identity format = per-origin trust)

`CREDENTIAL_OFFER` messages with `format === 'attestto-id'` are accepted under a **trust-on-first-use** model gated by the **sender origin**:

1. First sight of `attestto-id` from a given origin → OS notification asks the user to approve. Notification copy explicitly tells the user that approving trusts the site for future syncs.
2. On approve → `recordTrustedOrigin(origin)` stamps the origin into `chrome.storage.local[STORAGE_KEYS.TRUSTED_ORIGINS]`, then runs the normal offer acceptance.
3. Subsequent `attestto-id` offers from the same origin → silent auto-accept, no notification.

**Why:** the previous "auto-accept any attestto-id from any origin" approach (shipped morning of 2026-06-25, audited & reverted same day) let any web page push an arbitrary `didUri` into `linkedIdentities[]` with no user gesture. The fix preserves the silent-sync UX users expect from a logged-in platform while ensuring the *first* sync from each origin is an explicit user decision.

**Where:**
- `src/utils/trusted-origins.ts` — `isOriginTrusted` / `recordTrustedOrigin` / `revokeTrustedOrigin` over a single chrome.storage.local entry.
- `background.ts` `CREDENTIAL_OFFER` handler — captures `sender.origin`, gates the auto-accept on `isOriginTrusted`, otherwise falls through to OS notification.
- `background.ts` `acceptCredentialOffer` — records origin as trusted only when the format is `attestto-id` (one-off VC issuance is not recurring sync, so no benefit to persisting trust).

**Non-identity formats (`sd-jwt`, `json-ld`)** always require explicit accept via OS notification — they are one-off issuance events, not recurring sync.

**Architectural debt:** CORTEX currently sends `ATTESTTO_CREDENTIAL_OFFER` for identity sync; should send `ATTESTTO_DID_SYNC` instead (which `handleDidSync` routes natively into `linkedIdentities[]` without going through the credential channel). When CORTEX is fixed, the entire `attestto-id` branch — including the trust-on-first-use gate — can be deleted in favor of the direct sync path.

## Sync flow (extension ↔ platform)

**Direction: platform → extension.** The extension is the receiver of identity material.

1. User completes onboarding on `app.attestto.com/onboarding`
2. attestto-app generates the SNS subdomain allocation, gets the user's public JWK
3. attestto-app posts `ATTESTTO_DID_SYNC` to `window` (caught by `credential-api.content.ts`)
4. Content script forwards to `background.ts` → `handleDidSync`
5. Background stores `{ did, verificationMethod, tenantId }` in `linkedIdentities[]` (encrypted + public vault — see dual-vault rule above)
6. Popup opens, `loadPublicData()` reads public vault → identity shows in `IdentityListView`

**Current gap (2026-06-25):** `attestto-app` does NOT yet emit `ATTESTTO_DID_SYNC` after onboarding completes. The DID lands in the PWA's IndexedDB but never reaches the extension. The empty-state "Get Started" link now points to the correct URL (`app.attestto.com/onboarding`), but the round-trip isn't closed. **Filing the bridge work belongs in `attestto-app`, not here.**

## Storage namespace gotcha

Chrome derives the extension ID from the install path. So:

- `.output/chrome-mv3-dev/` → one extension ID → one `chrome.storage` namespace
- `.output/chrome-mv3/` (production) → different extension ID → different `chrome.storage` namespace

Loading the dev build does NOT see data created by the prod build (or vice versa). Don't treat "no data after rebuild" as a bug without first confirming which build Chrome has loaded.

## Working rules

- Tier 1 `did:jwk` is the first-run identity, not a fallback. The extension must be able to create a usable wallet and identity with no external service. Do not add a flow that requires the platform before a user can start.
- Don't link to `attestto.net` from extension UI — it's gated, users see Cloudflare Access wall.
- Don't add new content script matchers without thinking about the security surface — `credential-api.content.ts` currently runs on `https://*/*`.
- Background SW changes require a `chrome://extensions` reload (HMR doesn't restart the service worker). Popup/Vue changes hot-reload via Vite dev server.
- WXT dev mode opens a fresh Chrome window with the extension auto-loaded — if you can't see your changes, check whether you're looking at the right Chrome window or whether you loaded `.output/chrome-mv3/` (production, stale) instead of `.output/chrome-mv3-dev/`.

## Branch hygiene (no branch left forgotten)

Default branch is `develop`. `feature/*` and `fix/*` branch from `develop`, merge back via PR.

- **Every PR is squash-merged with `--delete-branch`.** The repo also has `delete_branch_on_merge` enabled, so a merged head branch is removed automatically — never leave it behind manually either.
- **A branch exists only while its PR is open.** No long-lived personal branches. If work stalls, either open a draft PR (so it's tracked) or delete the branch — never leave an orphan with no PR.
- **Dependabot PRs are merged or closed within the week**, not left to pile up. An open `dependabot/*` branch with no decision is debt.
- **Before starting work, prune first:** `git fetch --prune`, then delete any local branch whose upstream is gone (`git branch -v | grep gone`).
- **`main`/`master` are frozen legacy** (pre-gitflow, no common ancestor with `develop`). Do not branch from them, PR into them, or resurrect them. Retire only with explicit owner sign-off after confirming nothing (Web Store listing, CI, DNS) points at them.
- When you finish any branch task, the last step is: confirm the branch is deleted. A merged PR with a surviving branch is an incomplete task.

## Key files

| File | Purpose |
|---|---|
| `src/entrypoints/background.ts` | MV3 service worker — `handleDidSync`, auth, signing, key rotation, credential offers |
| `src/entrypoints/popup/App.vue` | Popup root — lock/unlock UI gate, router-view |
| `src/entrypoints/credential-api.content.ts` | postMessage ↔ chrome.runtime bridge, all https origins |
| `src/stores/wallet.ts` | Pinia store — `isSetUp`, `isUnlocked`, `linkedIdentities`, `loadPublicData`, `unlock`, `setup` |
| `src/utils/vault.ts` | Dual-vault read/write — `readVault`/`writeVault` (encrypted), `readPublicVault`/`writePublicVault`/`syncPublicVault` (public) |
| `src/utils/webauthn.ts` | Passkey setup + PRF-derived AES-GCM key for vault encryption |
| `src/utils/did-jwk.ts` | `publicJwkToDid`, `didJwkVerificationMethod` — self-resolving local DID primitive |
| `src/views/identity/IdentityListView.vue` | Empty state + identity cards — onboarding entry point to `app.attestto.com/onboarding` |
| `src/services/shamir.ts` | 2-of-3 GF(256) social recovery |
| `wxt.config.ts` | Manifest, CSP, permissions |

## Forbidden

- No PII, private keys, raw credentials in commits
- No "Co-Authored-By" in commits
- No internal references in user-visible strings (no "ATT-xxx", no "@attestto/" mentions in UI copy)
- Never write to chrome.storage without going through the vault utils — direct `chrome.storage.local.set` for vault keys bypasses encryption + sync rules
