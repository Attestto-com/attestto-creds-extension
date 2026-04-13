# Attestto Creds Extension

Self-sovereign identity wallet for the browser. Store verifiable credentials, present them with selective disclosure, and manage DID keys — all locally encrypted, never sent to a server.

Built with [WXT](https://wxt.dev) (Manifest V3), Vue 3, and Tailwind CSS 4.

## Features

- **Verifiable Credentials** — Store and manage SD-JWT VC and JSON-LD VC credentials
- **Selective Disclosure** — Choose exactly which fields to reveal per presentation (SD-JWT per-claim, JSON-LD full VP)
- **DIDComm v2** — Present Proof 3.0 protocol for P2P encrypted credential exchange
- **DID Key Management** — Generate P-256 keypairs, self-resolving `did:jwk` identifiers
- **DID Sync** — Link extension keys to platform-assigned DIDs (`did:sns`, `did:web`, `did:pkh`)
- **Key Rotation** — Generate fresh keypairs and atomically swap with the platform
- **Social Recovery** — 2-of-3 Shamir secret sharing (GF(256)) for private key backup
- **Encrypted Vault** — AES-256-GCM encrypted local storage, session-scoped decryption key
- **Solana Integration** — View linked wallet tokens (SPL + Token-2022)
- **W3C Credential API Bridge** — Content script intercepts `navigator.credentials.get()` for CHAPI-compatible flows
- **i18n** — English and Spanish out of the box, easily extensible

## Architecture

```
popup/                  Vue 3 app (memory router, Pinia stores)
  ├── WalletView        DID status, lock/unlock, linked Solana wallet
  ├── CredentialsView   Stored VCs list, pending proof requests
  ├── PresentView       Selective disclosure + VP generation
  ├── ConsentView       Field-level approve/decline for proof requests
  ├── PreparedView      Push-then-present VPs ready for verifiers
  └── SettingsView      Quick settings + link to full options page

background.ts           MV3 Service Worker
  ├── Crypto signing    P-256 ECDSA via Web Crypto API
  ├── Credential offer  Accept/reject incoming VCs
  ├── CHAPI handler     Consent popup → VP generation → response
  ├── DID Sync          Store platform-assigned DID + return public JWK
  ├── Key Rotation      Fresh P-256 keypair, return old + new public keys
  ├── Key Backup        Split private key into 3 Shamir sub-shares
  ├── Key Restore       Reconstruct from any 2 sub-shares
  └── DIDComm v2        Parse proof requests, build presentations

credential-api.ts       Content Script (ISOLATED world, all HTTPS pages)
  └── Bridges postMessage ↔ chrome.runtime for:
      ATTESTTO_VP_REQUEST, ATTESTTO_DID_SYNC, ATTESTTO_KEY_ROTATE,
      ATTESTTO_KEY_BACKUP, ATTESTTO_KEY_RESTORE, ATTESTTO_LIST_CREDENTIALS,
      ATTESTTO_RESHARE_VP

offscreen/              Offscreen document for WebSocket notifications
```

### MV3 Service Worker Constraints

The Service Worker goes to sleep after ~30 seconds of inactivity. This extension handles it as follows:

- **State persistence:** Encrypted vault in `chrome.storage.local`, decryption key in `chrome.storage.session` (persists while browser is open, clears on restart). No in-memory state survives sleep.
- **WebSocket keepalive:** The Offscreen Document runs as a standard JS context (not a SW), so it CAN hold a WebSocket open. An alarm fires every 4 minutes to ensure the offscreen document is still alive.
- **Signing flow:** Content Script → message → SW wakes up → reconstructs wallet from session storage → signs → replies.

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+

### Install & Dev

```bash
npm install
npm run dev           # Chrome, hot-reload
npm run dev:firefox   # Firefox
```

Load the unpacked extension from `.output/chrome-mv3-dev/` in `chrome://extensions` (enable Developer mode).

### Build

```bash
npm run build             # Chrome production
npm run build:firefox     # Firefox production
npm run zip               # Packaged .zip for Chrome Web Store
```

### Test

```bash
npm test                  # Vitest watch mode
npm run test:run          # Single run (CI)
npm run test:coverage     # Coverage report
npm run type-check        # vue-tsc type checking
```

101 tests across 10 spec files covering: Shamir (20), DIDComm (12), JSON-LD VP (15), did:jwk (10), DID Sync + Key Rotation (13), SD-JWT (5), Signing (3), Credential Handler (11), Credentials Store (7), Solana Tokens (5).

## Message Protocol

The extension communicates with web pages via `window.postMessage`. A platform or dApp sends a request; the content script bridges it to the background service worker and returns the response.

### Extension Detection

```js
// Check if extension is installed
const installed = document.documentElement.hasAttribute('data-attestto-creds')
```

### VP Request (Credential Presentation)

```js
// Page → Extension
window.postMessage({
  type: 'ATTESTTO_VP_REQUEST',
  requestId: crypto.randomUUID(),
  payload: {
    protocol: 'chapi',           // 'chapi' | 'attestto'
    challenge: 'verifier-nonce',
    domain: 'verifier.example',
    queryType: 'QueryByExample',
    credentialType: 'VerifiablePresentation',
    // Attestto-specific fields (when protocol = 'attestto')
    nonce: '...',
    requestedFields: ['name', 'dateOfBirth'],
    audience: 'did:web:verifier.example',
  },
})

// Extension → Page
window.addEventListener('message', (e) => {
  if (e.data.type === 'ATTESTTO_VP_RESPONSE') {
    const { requestId, presentation, error } = e.data
  }
})
```

### DID Sync (Link Extension Key to Platform DID)

```js
window.postMessage({
  type: 'ATTESTTO_DID_SYNC',
  requestId: crypto.randomUUID(),
  holderDid: 'did:sns:alice.sol',
  verificationMethod: 'did:sns:alice.sol#ext-key',
})
// Response: { type: 'ATTESTTO_DID_SYNC_RESPONSE', publicKeyJwk, holderDid }
```

### Key Rotation

```js
window.postMessage({
  type: 'ATTESTTO_KEY_ROTATE',
  requestId: crypto.randomUUID(),
})
// Response: { type: 'ATTESTTO_KEY_ROTATE_RESPONSE', newPublicKeyJwk, oldPublicKeyJwk }
```

### Key Backup (2-of-3 Shamir)

```js
window.postMessage({
  type: 'ATTESTTO_KEY_BACKUP',
  requestId: crypto.randomUUID(),
})
// Response: { type: 'ATTESTTO_KEY_BACKUP_RESPONSE', shares: [
//   { data: '<base64url>', index: 1 },  // Device share
//   { data: '<base64url>', index: 2 },  // Cloud share
//   { data: '<base64url>', index: 3 },  // Guardian share
// ]}
```

### Key Restore

```js
window.postMessage({
  type: 'ATTESTTO_KEY_RESTORE',
  requestId: crypto.randomUUID(),
  shareA: { data: '<base64url>', index: 2 },
  shareB: { data: '<base64url>', index: 3 },
})
// Response: { type: 'ATTESTTO_KEY_RESTORE_RESPONSE', success: true }
```

### List Stored Credentials

```js
window.postMessage({
  type: 'ATTESTTO_LIST_CREDENTIALS',
  requestId: crypto.randomUUID(),
})
// Response: { type: 'ATTESTTO_LIST_CREDENTIALS_RESPONSE', credentials: [...] }
```

### Reshare a Stored VP

```js
window.postMessage({
  type: 'ATTESTTO_RESHARE_VP',
  requestId: crypto.randomUUID(),
  credentialId: 'vc-uuid',
  selectedFields: ['name', 'dateOfBirth'],
})
// Response: { type: 'ATTESTTO_RESHARE_VP_RESPONSE', presentation, error }
```

## Credential Formats

| Format | Standard | Selective Disclosure |
|---|---|---|
| SD-JWT VC | [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) | Per-claim (salt + hash) |
| JSON-LD VC | [W3C VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) | Full VP with JWS proof |

## DID Methods

| Method | Resolution | Notes |
|---|---|---|
| `did:jwk` | Local (self-resolving) | Default for extension-generated keys |
| `did:sns` | Platform resolver | Solana Name Service anchored |
| `did:web` | HTTP | Platform-assigned |
| `did:pkh` | Derived from address | Wallet-linked |

## Security Model

| Aspect | Implementation |
|---|---|
| **Keys at rest** | AES-256-GCM encrypted in `chrome.storage.local` |
| **Keys in use** | Decryption key in `chrome.storage.session` (RAM-only, cleared on browser close) |
| **Key isolation** | Private keys never reach content scripts (which run inside web pages) |
| **Signing** | P-256 ECDSA via Web Crypto API |
| **Key backup** | 2-of-3 Shamir GF(256) — device + cloud + guardian sub-shares |
| **Consent** | Every proof request requires explicit user approval with field-level control |
| **CSP** | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` |
| **PII** | Credentials stored locally, presentations built on-device, nothing transmitted without consent |

## Project Structure

```
src/
├── entrypoints/
│   ├── popup/              Main popup app (Vue 3)
│   ├── options/            Full settings page
│   ├── background.ts       MV3 service worker
│   ├── credential-api.ts   W3C Credential API bridge (content script)
│   └── offscreen/          WebSocket notifications
├── services/
│   ├── shamir.ts           2-of-2 XOR + 2-of-3 GF(256) secret sharing
│   ├── didcomm.ts          DIDComm v2 Present Proof 3.0
│   ├── sdjwt.ts            SD-JWT parse, decode, present
│   ├── jsonld-vp.ts        JSON-LD VP with JWS proof
│   ├── credential-handler.ts  CHAPI bridge script (MAIN world injection)
│   └── signing.ts          P-256 ECDSA signing
├── stores/
│   ├── credentials.ts      Pinia store for stored VCs
│   ├── proof-requests.ts   Pending proof requests + prepared presentations
│   └── wallet.ts           DID, keys, linked Solana address
├── utils/
│   ├── vault.ts            Encrypted read/write to chrome.storage.local
│   ├── did-jwk.ts          did:jwk generation + self-resolving DID Document
│   ├── crypto.ts           AES-256-GCM encrypt/decrypt helpers
│   └── messaging.ts        Typed chrome.runtime message definitions
├── composables/
│   └── useSolanaTokens.ts  Fetch SPL + Token-2022 balances
├── components/             Reusable Vue components
├── views/                  Page-level views (wallet, credentials, consent, settings)
├── config/
│   └── app.ts              App name, version, storage keys
├── i18n/
│   └── locales/            Self-contained en.ts + es.ts
├── types/
│   ├── credential.ts       VC/VP type definitions
│   └── solana.ts           Token types
└── router/                 Memory-based popup routing
```

## Dependencies

| Package | Purpose |
|---|---|
| `wxt` | Vite-based MV3 bundler |
| `vue` / `vue-router` / `pinia` | UI framework, routing, state |
| `vue-i18n` | Internationalization |
| `tailwindcss` / `@tailwindcss/vite` | Utility-first CSS |
| `@heroicons/vue` | Icon library |
| `jose` | JOSE/JWK/JWS operations |
| `@sd-jwt/decode` / `@sd-jwt/present` | SD-JWT selective disclosure |
| `@solana/web3.js` | Solana RPC for token balances |

| `axios` | HTTP client |
| `zod` | Runtime schema validation |

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure all tests pass (`npm run test:run`)
5. Submit a PR

Please open an issue first for significant changes so we can discuss the approach.

## License

[Apache 2.0](./LICENSE)
