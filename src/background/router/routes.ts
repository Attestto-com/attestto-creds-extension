/**
 * Story 1.1 — the exhaustive route registry.
 *
 * `MESSAGE_ROUTES` is keyed by the `MessageType` union via a MAPPED TYPE
 * (`{ [K in MessageType]: Route<K> }`), never `Record<string, …>` and never
 * `keyof typeof MESSAGE_ROUTES`. That mapped domain is what makes a missing
 * route a `vue-tsc` COMPILE ERROR: adding a `MessageType` member without an
 * entry here fails the build (AC2, permanent tripwires in `routes.type-guards.test-d.ts`).
 *
 * Shim-first (AD-12): this registry is DECLARED and exported but NOT consumed —
 * the legacy `switch` in `background.ts` still drives every dispatch. Every
 * entry is an inert placeholder; `handle` throws if ever called by mistake.
 *
 * `bundle` tags are PROVISIONAL annotations (Story 1.4 makes them load-bearing).
 * Tagged conservatively: key-touching ops = `keyAdmin`, vault-reading/signing =
 * `signing`, consent-window flows = `consent`, side-effect-free acks = `untrusted`.
 */
import type { MessageType } from './message-types'
import type { CtxBundleTag, Route } from './route'
import { handleDidcommInbound } from '@/background/handlers/didcomm-inbound.handler'
import { handleDidSync } from '@/background/handlers/did-sync.handler'

function notImplemented(): never {
  throw new Error(
    'router not wired yet — the legacy switch drives dispatch (wired in Story 1.5)',
  )
}

/** Build an inert placeholder route. Not consumed until Story 1.5. */
function stubRoute<K extends MessageType>(bundle: CtxBundleTag): Route<K> {
  return {
    bundle,
    allowFrom: { origins: [], senders: [] }, // empty = fail-closed until Story 1.5 fills it
    validate: (raw) => raw as never, // placeholder; real narrowing is Story 1.5
    handle: () => notImplemented(),
  }
}

// Story 1.9 — the first EXTRACTED route. Declared with its precise tag
// (`Route<K, 'untrusted'>`) so the handler's ctx is `UntrustedCtx`, not the
// heterogeneous `AnyCtx`; method-bivariance then stores it as `Route<K>` in the
// registry below. `handle` is the real handler.
//
// Story 2.2 — `verifyPeer` is now a REAL, executed check, and was renamed from
// `{ check: 'envelope' }` to `{ check: 'senderResolvable' }` because that is all
// it establishes: the claimed sender DID parses, uses an allowed method, and
// resolves to a document with an authentication key. It is NOT authentication —
// the DIDComm envelope parsed here carries no signature, so there is nothing to
// verify against. `envelope` would have implied otherwise.
//
// `allowFrom` stays empty: the case delegates to `handle` directly (parity — no
// legacy sender-auth), so the empty descriptor is not consulted until the case
// routes through dispatch.
const didcommInboundRoute: Route<'DIDCOMM_INBOUND', 'untrusted'> = {
  bundle: 'untrusted',
  allowFrom: { origins: [], senders: [] },
  validate: (raw) => raw as never,
  handle: handleDidcommInbound,
  verifyPeer: { check: 'senderResolvable' },
}

// Story 1.10 — the second EXTRACTED route (first KeyAdmin). `handle` is the real
// vault-mutation handler; it returns the DID_SYNC_RESPONSE data (the case
// transports it). Story 2.2 — `verifyPeer: { check: 'vmBinding' }` is now
// EXECUTED: the claimed `verificationMethod` must appear in the document the
// claimed `holderDid` publishes, so a page can no longer name an arbitrary key
// URI for a DID whose document does not contain it. Proof-of-CONTROL (that the
// sender holds the corresponding private key) still requires a signature over a
// challenge and remains open as FR26 — the accepted risk, now narrowed.
// `allowFrom` stays empty: origin authorization is dynamic (`isOriginTrusted`,
// which a static descriptor cannot express), so the case keeps its inline gate and
// delegates only the vault work here (parity — one axis of change).
const didSyncRoute: Route<'DID_SYNC', 'keyAdmin'> = {
  bundle: 'keyAdmin',
  allowFrom: { origins: [], senders: [] },
  validate: (raw) => raw as never,
  handle: handleDidSync,
  verifyPeer: { check: 'vmBinding' },
}

export const MESSAGE_ROUTES: { [K in MessageType]: Route<K> } = {
  NOTIFICATION_RECEIVED: stubRoute('untrusted'),
  SESSION_EXPIRED: stubRoute('untrusted'),
  WALLET_ACTIVITY: stubRoute('untrusted'),
  CREDENTIAL_OFFER_GET_PENDING: stubRoute('consent'),
  CREDENTIAL_OFFER_APPROVE: stubRoute('consent'),
  CREDENTIAL_OFFER_DENY: stubRoute('consent'),
  CREDENTIAL_OFFER: stubRoute('consent'),
  WALLET_LINK: stubRoute('signing'),
  PROOF_ACCESS_REQUEST: stubRoute('signing'),
  PUSH_PRESENTATION: stubRoute('signing'),
  DIDCOMM_INBOUND: didcommInboundRoute,
  CREDENTIAL_API_REQUEST: stubRoute('signing'),
  LIST_STORED_CREDENTIALS: stubRoute('signing'),
  RESHARE_STORED_VP: stubRoute('signing'),
  DID_SYNC: didSyncRoute,
  KEY_ROTATE: stubRoute('keyAdmin'),
  KEY_BACKUP: stubRoute('keyAdmin'),
  KEY_RESTORE: stubRoute('keyAdmin'),
  CREDENTIAL_ACCEPTED: stubRoute('untrusted'),
  CREDENTIAL_REJECTED: stubRoute('untrusted'),
  SIGN_DOCUMENT_REQUEST: stubRoute('signing'),
  SIGN_DOCUMENT_GET_PENDING: stubRoute('consent'),
  SIGN_DOCUMENT_APPROVE: stubRoute('signing'),
  SIGN_DOCUMENT_DENY: stubRoute('consent'),
  AUTH_REQUEST: stubRoute('signing'),
  CW_AUTH_REQUEST: stubRoute('signing'),
  AUTH_GET_PENDING: stubRoute('consent'),
  AUTH_APPROVE: stubRoute('signing'),
  AUTH_DENY: stubRoute('consent'),
  SIGN_ATTESTTO_PDF_REQUEST: stubRoute('signing'),
  SIGN_ATTESTTO_PDF_GET_PENDING: stubRoute('consent'),
  SIGN_ATTESTTO_PDF_APPROVE: stubRoute('signing'),
  SIGN_ATTESTTO_PDF_DENY: stubRoute('consent'),
  PAYMENT_REQUEST: stubRoute('signing'),
  PAYMENT_GET_PENDING: stubRoute('consent'),
  PAYMENT_APPROVE: stubRoute('signing'),
  PAYMENT_DENY: stubRoute('consent'),
  CHAPI_GET_PENDING: stubRoute('consent'),
  CHAPI_APPROVE: stubRoute('signing'),
  CHAPI_DENY: stubRoute('consent'),
  CERT_SCAN_REQUEST: stubRoute('untrusted'),
  SUBMIT_THREAT_REPORT: stubRoute('untrusted'),
}
