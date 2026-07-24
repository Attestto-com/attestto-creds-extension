# `.cr` Real-Time Threat Analyzer — Extension Design

**Date:** 2026-07-24
**Repo:** `attestto-creds-extension` (browser extension, MV3) + a backend cert-scan endpoint (host TBD)
**Related:** ATT-630 (trust registry), ATT-705 (extension signals), phishing-extension UX, per-event consent, `@attestto/tls-audit`
**Status:** Design for review

## Vision

On every Costa-Rican website the user visits, the extension analyzes the page and its certificate **locally** for threats. It is **silent and invisible** on clean sites. Only when it finds a warning or alert does it inject UI — a drawer bar that pushes page content down — and ask the user, per-event, whether to send the log. Nothing leaves the browser without explicit consent.

## Keystone principle: never inject positive trust; only inject warnings

- **Positive "verified / green" signals are forgeable pixels.** Any site can render a fake green seal or checkmark. Injecting a positive trust badge into a page is therefore worthless at best and deceptive at worst. Positive verification lives **only in browser chrome** (the toolbar popup), which a page cannot touch or forge.
- **Warnings are self-authenticating by incentive.** No malicious site will ever fake an alert *about itself* ("this site may be impersonating BCCR"). An adverse signal has no forgery incentive, so it is safe and valuable to inject into the page.
- Consequence: the on-page surface is **exclusively** for warnings/alerts. All positive state moves to the popup.

This **replaces** the extension's current proactive on-page green trust bar/badge for gov hosts. Positive "this is a verified institution" state is still available — but only if the user opens the popup.

> **Publishable thesis (blog post + whitepaper — do not lose):** "Trust seals are forgeable pixels; warnings are self-authenticating." Positive trust indicators rendered inside a page are worthless because any site can copy them (the historical failure of SSL/TRUSTe seals). Adverse indicators are trustworthy precisely because no attacker will fake an alert about their own site. Therefore: positive trust must live in unforgeable browser chrome; only warnings belong on the page. This is a strong, contrarian public-content spine for Attestto's anti-phishing positioning.

### On-page injection taxonomy (refined)

The rule "only warnings on the page" refines into two things the extension MAY inject — both in the extension's own unforgeable UI (shadow DOM drawer), never as a site-style seal:

1. **Adverse findings** (self-authenticating): phishing/homograph/cert threats **and** data-practice findings — PII leaks, excessive or repeated info collection. No site fakes these about itself.
2. **The extension's own assistive offers** (own voice, not a site-trust claim): e.g. "this form can be completed formless with Attestto." This is allowed because it is Attestto speaking in Attestto's chrome — it is not a forgeable *positive trust seal about the site*. It never asserts the site is safe.

Still forbidden, always: injecting a forgeable **positive trust seal about the site** ("this site is verified/safe"). That stays in the popup only.

## Scope

- **Trigger:** all Costa-Rica public and general zones — `.cr`, `.co.cr`, `.fi.cr`, `.go.cr`, `.ac.cr`, `.ed.cr`, `.or.cr`, `.sa.cr`. Widen the content-script match patterns from today's `GOV_TLDS`-only set to the full `.cr` set.
- **Every page** on those zones is analyzed (not just known registry hosts).

## Architecture

```
Content script (all .cr zones)
   │  (100% local, zero network)
   ├─ Page analyzers:
   │    • homograph / brand-squat vs trust registry (homograph.ts + brand labels)
   │    • phishing heuristics (credential-harvest forms, look-alike of a registry brand, …)
   │    • client-observable cert/HTTPS signals (scheme, mixed content, snapshot match for known hosts)
   │
   ├─ Clean result → DO NOTHING on the page. (Popup, if opened, shows positive/verified state.)
   │
   └─ Warning/alert result → inject the DRAWER BAR (pushes page content down),
         state the specific threat, and ask: "Send the log?"  (per-event consent)
                │  user consents
                ▼
        Backend cert-scan endpoint  →  @attestto/tls-audit fetchLiveCert + classifyCert
        (hostname only) + log submission.  Deep cert verdict returned to the drawer.
```

- The **always-on layer is fully local** — no automatic network calls, so no per-visit phone-home.
- The **backend is touched only on explicit consent**, and receives **only the hostname** plus the finding log — never the full URL/path, never page content.
- `@attestto/tls-audit` runs **server-side** (MV3 cannot read the served leaf cert); it is invoked only in the consented path.

## UI: the drawer

- Appears only on a warning/alert. Slides down from the top and **displaces** page content (drawer, not overlay) so it cannot be visually spoofed under existing page chrome.
- States the specific finding (e.g. "This domain's brand resembles BCCR but is not the registered BCCR host").
- Primary action: **Send the log** (consent). Secondary: dismiss. Optional: "why am I seeing this?"
- Uses the extension's own rendered UI (shadow DOM / isolated styles) so the page cannot style or suppress it.

## Positive state (popup only)

- The toolbar popup shows the trust verdict for the current site: registry match, gov-host status, snapshot cert info if available. This is the *only* place a "verified / green" signal appears. The page is never told.

## Privacy contract (hard requirements)

- Nothing leaves the browser without explicit per-event user consent.
- On consent, transmit only: the **hostname** and the **finding log**. Never the full URL, query, path, form values, or page DOM/content.
- No automatic background requests per `.cr` visit.
- No cross-site browsing profile is assembled client- or server-side.

## Findings the local layer produces

Conservative by default — a wrongly-injected finding cries wolf. Grouped by intent:

**Threat warnings (adverse, high-confidence only at launch):**
- **Homograph / brand-squat:** brand label matches a registry brand but the full host does not (existing `homograph.ts`).
- **Look-alike phishing:** page presents as a registry institution (logo/name/copy) on a non-registry host.
- **Credential-harvest heuristics:** login/password forms on suspicious hosts, off-registry action targets.
- **Cert signals (client-observable):** non-HTTPS, mixed content, or a mismatch against the bundled snapshot for a known host. Deep cert classification (CA / DV-OV-EV / expiry / chain) is the consented backend step.

**Data-practice findings (adverse, informational):**
- **PII leaks:** the page exposes or transmits PII in the clear, in URLs/query strings, or to third-party origins.
- **Excessive / repeated info collection:** forms requesting more personal data than the task warrants, or re-asking for data the user already provided.

**Assistive offers (Attestto's own voice — a funnel, not a trust claim):**
- **Formless opportunity:** a form on the page could be completed **formless** with Attestto (credential presentation instead of manual entry). Surfaced as an Attestto offer in the drawer, clearly the extension speaking. Ties into the formless / VP-autofill flow and the signature-to-ID growth loop.

Launch posture: threat warnings are conservative (homograph/brand-squat + non-HTTPS + snapshot mismatch). Data-practice and assistive findings ship behind the same silent-unless-relevant rule and are tuned to avoid nagging.

## Changes to the existing extension

- Widen `GOV_MATCH_PATTERNS` from `GOV_TLDS` to the full `.cr` set.
- Remove the proactive on-page green trust bar/badge; relocate positive state to the popup.
- Keep the drawer as the sole on-page surface, gated on findings.
- Reuse the trust registry (`trust-registry.ts` + seed) and `homograph.ts` as-is.

## Non-goals

- No positive seals or badges injected into any page, ever.
- No automatic per-visit network calls.
- No sending of URLs, page content, or form data.
- No client-side live-cert reading (MV3 can't; deep cert scan is the consented backend step).

## Resolved decisions (2026-07-24)

1. **Backend endpoint home → new dedicated service.** A small standalone service handles the consent-only `tls-audit fetchLiveCert` cert scan + log intake. Kept separate from CORTEX (internal platform) and the resolver. Auth/rate model TBD in the plan.
2. **Log schema (draft):** `{ findingType, severity, hostname, tld, timestamp, certVerdict?, heuristicIds[], extensionVersion }`. Never includes full URL/path, query, form values, or page content.
3. **Warning aggressiveness → conservative** at launch (homograph/brand-squat + non-HTTPS + snapshot mismatch). Data-practice and assistive findings tuned to avoid nagging.
4. **Snapshot → kept** as the offline cert reference for known hosts; the consented backend scan augments it for unknown hosts.
5. **Popup positive-state scope:** registry match + gov-host status + snapshot cert info (CA / tier / expiry) when available.

## Open for the plan

- Dedicated service: language/stack, hosting, auth + rate-limiting, and how it imports `@attestto/tls-audit`.
- The exact conservative heuristic rule list and false-positive test corpus for threat warnings.
- PII-leak and excessive/repeated-info detector rules (client-side) and their nag-avoidance tuning.
- Formless-opportunity detection: how a form is recognized as formless-eligible, and the offer's link into the VP-autofill flow.
