/**
 * Story 1.1 — the exhaustive message-type union for the background router.
 *
 * `MessageType` is the set of inter-context messages the MV3 service worker
 * DISPATCHES (the ~43 `case` labels of the legacy `switch (message.type)` in
 * `background.ts`). It is deliberately NOT `ExtensionMessage['type']`: that wire
 * union also carries `PRESENTATION_REQUEST` / `PROOF_ACCESS_RESPONSE`, which are
 * background→content OUTBOUND messages the switch never dispatches. Router
 * ownership is the dispatched set only.
 *
 * `MESSAGE_TYPES` (the runtime tuple) is the single source of truth; the union
 * derives from it via `typeof MESSAGE_TYPES[number]`. It is a runtime value on
 * purpose — the migration guard (`message-types.migration.spec.ts`) needs a
 * real array to compare against the switch AST. The union is NOT derived from
 * the routes object (`keyof typeof MESSAGE_ROUTES`), which would invert the
 * dependency and collapse exhaustiveness.
 *
 * Shim-first (AD-12): this module is declared, not yet consumed. The legacy
 * switch still drives 100% of dispatch. Payload shapes here are DECLARATIONS —
 * real per-field validation is Story 1.5's `validate`, not this story.
 */
import type {
  NotificationReceivedMessage,
  SignRequestMessage,
  CredentialOfferMessage,
  CredentialAcceptedMessage,
  CredentialRejectedMessage,
  WalletLinkMessage,
  ProofAccessRequestMessage,
  PushPresentationMessage,
  DIDCommInboundMessage,
  CredentialApiRequestMessage,
  DidSyncMessage,
  KeyRotateMessage,
  KeyBackupMessage,
  KeyRestoreMessage,
  PaymentRequestMessage,
  SignDocumentRequestMessage,
  SignAttesttoPdfRequestMessage,
  CertScanRequestMessage,
  SubmitThreatReportMessage,
} from '@/utils/messaging'

// ── The dispatched-type tuple (single source of truth) ───────────────────────
// Order mirrors the legacy switch for reviewability. Adding a case to the switch
// without adding it here reddens the migration guard; adding it here without a
// route reddens `vue-tsc` (see MESSAGE_ROUTES).
export const MESSAGE_TYPES = [
  'NOTIFICATION_RECEIVED',
  'SESSION_EXPIRED',
  'AUTO_LOCK_CHANGED',
  'CREDENTIAL_OFFER_GET_PENDING',
  'CREDENTIAL_OFFER_APPROVE',
  'CREDENTIAL_OFFER_DENY',
  'SIGN_REQUEST',
  'CREDENTIAL_OFFER',
  'WALLET_LINK',
  'PROOF_ACCESS_REQUEST',
  'PUSH_PRESENTATION',
  'DIDCOMM_INBOUND',
  'CREDENTIAL_API_REQUEST',
  'LIST_STORED_CREDENTIALS',
  'RESHARE_STORED_VP',
  'DID_SYNC',
  'KEY_ROTATE',
  'KEY_BACKUP',
  'KEY_RESTORE',
  'CREDENTIAL_ACCEPTED',
  'CREDENTIAL_REJECTED',
  'SIGN_DOCUMENT_REQUEST',
  'SIGN_DOCUMENT_GET_PENDING',
  'SIGN_DOCUMENT_APPROVE',
  'SIGN_DOCUMENT_DENY',
  'AUTH_REQUEST',
  'CW_AUTH_REQUEST',
  'AUTH_GET_PENDING',
  'AUTH_APPROVE',
  'AUTH_DENY',
  'SIGN_ATTESTTO_PDF_REQUEST',
  'SIGN_ATTESTTO_PDF_GET_PENDING',
  'SIGN_ATTESTTO_PDF_APPROVE',
  'SIGN_ATTESTTO_PDF_DENY',
  'PAYMENT_REQUEST',
  'PAYMENT_GET_PENDING',
  'PAYMENT_APPROVE',
  'PAYMENT_DENY',
  'CHAPI_GET_PENDING',
  'CHAPI_APPROVE',
  'CHAPI_DENY',
  'CERT_SCAN_REQUEST',
  'SUBMIT_THREAT_REPORT',
] as const

/** The first-class discriminated union of every background-dispatched message. */
export type MessageType = (typeof MESSAGE_TYPES)[number]

// ── Payload shapes for the previously-unmodeled dispatched types ──────────────
// Captured from the fields each `case` body reads in background.ts. "Precise
// enough to compile"; exhaustive per-field validation is Story 1.5.

/** Approval-window handshake keyed by the OS-notification id. */
export interface NotifIdPayload {
  notifId: string
}
/** Approval/pending handshake keyed by an in-flight request id. */
export interface RequestIdPayload {
  requestId: string
}
/** Approve variants that also carry the DID the user picked in the window. */
export interface RequestIdWithSelectedDidPayload {
  requestId: string
  selectedDid: string
}

export interface ReshareStoredVpPayload {
  requestId: string
  credentialId: string
  selectedFields: string[]
}

export interface AuthRequestPayload {
  requestId: string
  nonce: string
  timestamp: string
  origin: string
}

export interface CwAuthRequestPayload {
  requestId: string
  nonce: string
  audience: string
  origin: string
  timestamp?: string
  trustedIssuers?: string[]
}

export interface AuthApprovePayload {
  requestId: string
  selectedDid?: string
}

// ── The tag → payload map ─────────────────────────────────────────────────────
// Every MessageType key present exactly once; `undefined` = message carries no
// payload (never `unknown`/`any` — see the not-loose assertion below and AC5).
export interface MessagePayloads {
  NOTIFICATION_RECEIVED: NotificationReceivedMessage['payload']
  SESSION_EXPIRED: undefined
  AUTO_LOCK_CHANGED: undefined
  CREDENTIAL_OFFER_GET_PENDING: NotifIdPayload
  CREDENTIAL_OFFER_APPROVE: NotifIdPayload
  CREDENTIAL_OFFER_DENY: Partial<NotifIdPayload>
  SIGN_REQUEST: SignRequestMessage['payload']
  CREDENTIAL_OFFER: CredentialOfferMessage['payload']
  WALLET_LINK: WalletLinkMessage['payload']
  PROOF_ACCESS_REQUEST: ProofAccessRequestMessage['payload']
  PUSH_PRESENTATION: PushPresentationMessage['payload']
  DIDCOMM_INBOUND: DIDCommInboundMessage['payload']
  CREDENTIAL_API_REQUEST: CredentialApiRequestMessage['payload']
  LIST_STORED_CREDENTIALS: RequestIdPayload
  RESHARE_STORED_VP: ReshareStoredVpPayload
  DID_SYNC: DidSyncMessage['payload']
  KEY_ROTATE: KeyRotateMessage['payload']
  KEY_BACKUP: KeyBackupMessage['payload']
  KEY_RESTORE: KeyRestoreMessage['payload']
  CREDENTIAL_ACCEPTED: CredentialAcceptedMessage['payload']
  CREDENTIAL_REJECTED: CredentialRejectedMessage['payload']
  SIGN_DOCUMENT_REQUEST: SignDocumentRequestMessage['payload']
  SIGN_DOCUMENT_GET_PENDING: RequestIdPayload
  SIGN_DOCUMENT_APPROVE: RequestIdWithSelectedDidPayload
  SIGN_DOCUMENT_DENY: RequestIdPayload
  AUTH_REQUEST: AuthRequestPayload
  CW_AUTH_REQUEST: CwAuthRequestPayload
  AUTH_GET_PENDING: RequestIdPayload
  AUTH_APPROVE: AuthApprovePayload
  AUTH_DENY: RequestIdPayload
  SIGN_ATTESTTO_PDF_REQUEST: SignAttesttoPdfRequestMessage['payload']
  SIGN_ATTESTTO_PDF_GET_PENDING: RequestIdPayload
  SIGN_ATTESTTO_PDF_APPROVE: RequestIdWithSelectedDidPayload
  SIGN_ATTESTTO_PDF_DENY: RequestIdPayload
  PAYMENT_REQUEST: PaymentRequestMessage['payload']
  PAYMENT_GET_PENDING: RequestIdPayload
  PAYMENT_APPROVE: RequestIdWithSelectedDidPayload
  PAYMENT_DENY: RequestIdPayload
  CHAPI_GET_PENDING: RequestIdPayload
  CHAPI_APPROVE: RequestIdPayload
  CHAPI_DENY: RequestIdPayload
  CERT_SCAN_REQUEST: CertScanRequestMessage['payload']
  SUBMIT_THREAT_REPORT: SubmitThreatReportMessage['payload']
}

/** The payload type for a given dispatched message. */
export type MessagePayload<K extends MessageType> = MessagePayloads[K]

// ── Compile-time invariants (no runtime cost) ─────────────────────────────────
type Assert<T extends true> = T

// The tuple and the payload map must describe exactly the same key set. If they
// drift, one of these two lines fails to compile.
type _TupleCoversMap = Assert<keyof MessagePayloads extends MessageType ? true : false>
type _MapCoversTuple = Assert<MessageType extends keyof MessagePayloads ? true : false>

// AC5 — no member's payload is a disguised `unknown`/`any` (the `payload as X`
// escape wearing a type hat). This proves NOT-unknown, NOT that any shape is
// correct — real shape validation is Story 1.5's `validate`.
type IsAny<T> = 0 extends 1 & T ? true : false
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false
type LoosePayloadMembers = {
  [K in MessageType]: IsAny<MessagePayload<K>> extends true
    ? K
    : IsUnknown<MessagePayload<K>> extends true
      ? K
      : never
}[MessageType]
type _NoLoosePayloads = Assert<[LoosePayloadMembers] extends [never] ? true : false>

export type { _TupleCoversMap, _MapCoversTuple, _NoLoosePayloads }
