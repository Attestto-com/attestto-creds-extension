# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- **8 Dependabot advisories closed, one critical.** `shell-quote` (command
  injection, critical, plus a second high), `adm-zip` (high), `tmp` (high),
  `vite` (high and medium), `uuid` (medium) and `esbuild` (low).
- **None of them reaches a user.** All eight are dev-only transitives, and the
  first four sit under the `web-ext-run` / `fx-runner` / `firefox-profile`
  chain that WXT uses to launch a local browser during `wxt dev`. The built
  bundle is byte-identical before and after at 664.44 kB, for both the Chrome
  MV3 and Firefox MV2 targets, which is what makes that claim checkable rather
  than asserted.
- **`vite` was not an override problem, it was a pin.** The root declared
  `"vite": "7.3.2"` exactly, and that exact pin was the vulnerable copy.
  Relaxed to `^7.3.6`, which stays inside the major that `wxt`,
  `@tailwindcss/vite` and `@vitejs/plugin-vue` all accept. `vite-node` keeps
  its own 8.1.0, already above its own floor, and was deliberately left alone:
  a single unbounded `vite` override would have dragged both copies onto one
  line.
- The other five are held by `overrides` bounded to their own major line, since
  an open-ended floor adopts the next major while still satisfying the
  advisory. Each resolved version was compared against its own advisory floor
  rather than inferred from `npm audit` reporting zero.

### Added

- **Per-site (pairwise) sign-in identity.** Each origin gets its own locally
  generated `did:jwk`, minted on first sign-in and reused afterwards, so sites
  cannot correlate a user across the web (`src/utils/site-did.ts`).
- **Shared site identity card** (`SiteIdentityCard.vue`) rendered by both the
  toolbar popup and the approval window: site favicon, name, domain, transport
  security (HTTPS), site verification status, and your per-site identity.
- **Returning-vs-new site recognition** in the approval window. A first visit
  shows an acknowledgment step (confirm the URL you meant to visit) as an
  anti-phishing check — a look-alike origin always reads as a first visit.
- Signing in to a site marks it as trusted, recorded from the popup context so
  it takes effect without reloading the background service worker.

### Changed

- The toolbar popup is now a single read-only site identity card. The
  cross-site "trusted sites" grid and the named-identity list were removed to
  avoid presenting a correlation surface.
- Approval windows auto-dismiss after 30s of inactivity, and the countdown
  resets on interaction so an active user is never cut off.
- Auth (login) approvals no longer show an identity picker — login uses the
  pairwise per-site identity. Deliberate flows (document signing, payments)
  keep the identity picker.

### Security

- Login identity is pairwise per origin; a portable identity is never presented
  as a login handle. A site that needs identity attributes must request a
  Verifiable Credential, which the user presents explicitly.
