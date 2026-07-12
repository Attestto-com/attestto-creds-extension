# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
