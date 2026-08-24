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

## The consent rules (these govern; code that disagrees is the bug)

Written down 2026-08-14 after a security review gated a capability that should
never have existed. Every reviewer before that read the code as the spec, because
these rules were nowhere a reviewer could reach them.

1. **A page is untrusted by default, and may only present itself.** It cannot ask
   what the wallet holds. It cannot ask for a credential. There is no page-facing
   read path into the vault, and adding one is not a hardening problem to be
   solved with a gate — it is out of scope by design.
2. **No DID, no conversation.** An origin that does not present a DID does not
   communicate with the extension at all.
3. **A trusted DID may ASK — and it asks the USER.** "Trusted" means ours, or on
   the whitelist of trusted issuers. Trust buys the right to make a request, not
   the right to an answer.
4. **There is never an auto-accept. Literally never.** No setting passes data to
   a site automatically, and none may be added. Approving an origin once is not
   standing consent for what it sends afterwards.

The user is the only party that decides what leaves the wallet, every time.

### What this replaced

This section previously described trust-on-first-use for `attestto-id` credential
offers: first offer from an origin raised a notification, and after approval every
later offer from that origin was **accepted silently**. That was written as a
hardening of an older hole (auto-accepting any `attestto-id` from any origin), so
it read as the safe version of a bad idea rather than as the bad idea.

Removed 2026-08-14. `handleCredentialOffer` now has no branch: every offer, every
format, every origin goes to the approval window. `CredentialOfferCtx` no longer
exposes `isOriginTrusted` or `accept`, so a silent path is unexpressible rather
than merely untaken.

Origin trust still exists and still means something — it authorizes the `DID_SYNC`
channel (`allowFrom: { policy: 'platform-or-trusted' }`). Authorization for a
channel is not consent for a payload.

**Where:**
- `src/utils/trusted-origins.ts` — `isOriginTrusted` / `recordTrustedOrigin` /
  `revokeTrustedOrigin`. Consumed by the router's origin policy, not by consent.
- `src/background/handlers/credential-offer.handler.ts` — the single-outcome
  intake decision, with the deleted branch documented in its header.
- `src/background/handlers/credential-offer.handler.spec.ts` — asserts absence.

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
