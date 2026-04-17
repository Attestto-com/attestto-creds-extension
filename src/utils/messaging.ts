/**
 * Typed helpers for chrome.runtime message passing.
 *
 * Centralizes message types so content scripts, popup, offscreen,
 * and the background service worker all speak the same protocol.
 */

import type { CredentialFormat } from '@/types/credential'

// ── Message Types ────────────────────────────────────

export interface NotificationReceivedMessage {
  type: 'NOTIFICATION_RECEIVED'
  payload: string
}

export interface SessionExpiredMessage {
  type: 'SESSION_EXPIRED'
}

export interface SignRequestMessage {
  type: 'SIGN_REQUEST'
  payload: string // base64 data to sign
}

export interface SignResponseMessage {
  ok: boolean
  signature?: string
  error?: string
}

export interface CredentialOfferMessage {
  type: 'CREDENTIAL_OFFER'
  payload: {
    format: CredentialFormat | string
    raw: string
    issuerName: string
    /** Pre-decoded claims (used by attestto-id push format) */
    claims?: Record<string, unknown>
  }
}

export interface CredentialAcceptedMessage {
  type: 'CREDENTIAL_ACCEPTED'
  payload: {
    credentialId: string
  }
}

export interface CredentialRejectedMessage {
  type: 'CREDENTIAL_REJECTED'
  payload: {
    reason?: string
  }
}

export interface PresentationRequestMessage {
  type: 'PRESENTATION_REQUEST'
  payload: {
    nonce: string
    requestedClaims: string[]
    audience: string
  }
}

export interface WalletLinkMessage {
  type: 'WALLET_LINK'
  payload: {
    address: string
  }
}

export interface ProofAccessRequestMessage {
  type: 'PROOF_ACCESS_REQUEST'
  payload: {
    credentialId: string
    requesterDid: string
    requesterName: string
    purpose: string
    requestedFields: string[]
    nonce: string
    audience: string
    expiresAt: string | null
    transport: 'platform' | 'didcomm_v2' | 'push_to_vault'
  }
}

export interface ProofAccessResponseMessage {
  type: 'PROOF_ACCESS_RESPONSE'
  payload: {
    requestId: string
    presentation: string | null
    error?: string
  }
}

export interface DIDCommInboundMessage {
  type: 'DIDCOMM_INBOUND'
  payload: Record<string, unknown>
}

export interface PushPresentationMessage {
  type: 'PUSH_PRESENTATION'
  payload: {
    credentialId: string
    presentation: string
    selectedFields: string[]
    expiresAt: string
  }
}

export interface CredentialApiRequestMessage {
  type: 'CREDENTIAL_API_REQUEST'
  payload: {
    requestId: string
    protocol: 'chapi' | 'attestto'
    // CHAPI standard fields
    challenge: string | null
    domain: string | null
    queryType: string | null
    credentialType: string | null
    // Attestto proprietary fields
    nonce: string
    requestedFields: string[]
    audience: string
    origin: string
  }
}

/**
 * DID Sync — platform pushes holder DID + verificationMethod to extension.
 *
 * Sent once during onboarding or when the platform assigns/rotates a DID.
 * The extension stores these in the vault and returns its public JWK so
 * the platform can include it in the DID Document.
 *
 * Flow: Platform page → content script → background → vault write → response with publicKeyJwk
 */
export interface DidSyncMessage {
  type: 'DID_SYNC'
  payload: {
    requestId: string
    /** The DID the platform assigned (did:sns, did:web, did:pkh, etc.) */
    holderDid: string
    /** Verification method URI in the DID Document (e.g. did:sns:alice.sol#ext-key) */
    verificationMethod: string
    /** Origin of the requesting page (for trust validation) */
    origin: string
    /** Platform tenant ID (for multi-tenant identity context) */
    tenantId?: string
  }
}

/**
 * Key Rotate — platform requests extension to generate a fresh keypair.
 *
 * The extension generates a new P-256 keypair, replaces the old private key
 * in the vault, and returns both the new public key and the old public key
 * (so the platform can track what was rotated).
 *
 * Flow: Platform page → content script → background → vault write → response with new + old publicKeyJwk
 */
export interface KeyRotateMessage {
  type: 'KEY_ROTATE'
  payload: {
    requestId: string
    /** Origin of the requesting page (for trust validation) */
    origin: string
  }
}

/**
 * Key Backup — extension splits its private key into 2-of-3 Shamir sub-shares
 * for social recovery. Returns the 3 shares (device, cloud, guardian) as base64url.
 *
 * The private key is encrypted with AES-256-GCM using a derived key before splitting,
 * so each sub-share is a share of the encrypted key, not the raw private key.
 */
export interface KeyBackupMessage {
  type: 'KEY_BACKUP'
  payload: {
    requestId: string
    origin: string
  }
}

/**
 * Key Restore — extension receives 2 sub-shares and reconstructs the private key.
 * Used after device loss when recovering from cloud+guardian or device+guardian.
 */
export interface KeyRestoreMessage {
  type: 'KEY_RESTORE'
  payload: {
    requestId: string
    shareA: { data: string; index: number } // base64url encoded
    shareB: { data: string; index: number } // base64url encoded
    origin: string
  }
}

/**
 * Payment Request — page sends payment details to extension for approval + signing.
 *
 * Flow: PaymentApprovalPage → content script → background → approval popup
 *       → user picks DID + approves → vault signs canonical payload
 *       → response with {did, signature, publicKeyJwk} → page calls POST /payments/pay/did
 */
export interface PaymentRequestMessage {
  type: 'PAYMENT_REQUEST'
  payload: {
    requestId: string
    paymentRequestUuid: string
    amount: number
    currency: string
    merchantName: string
    description?: string
    origin: string
  }
}

/**
 * Sign Document Request — page sends document details to extension for approval + DID signing.
 *
 * Flow: ExternalSigningPage → content script → background → approval popup
 *       → user approves → vault signs canonical payload `attestto:sign:{token}:{did}:{timestamp}`
 *       → response with {did, signature, publicKeyJwk, timestamp} → page calls sign endpoint
 */
export interface SignDocumentRequestMessage {
  type: 'SIGN_DOCUMENT_REQUEST'
  payload: {
    requestId: string
    signingToken: string
    documentTitle: string
    signerName: string
    origin: string
  }
}

export type ExtensionMessage =
  | NotificationReceivedMessage
  | SessionExpiredMessage
  | SignRequestMessage
  | CredentialOfferMessage
  | CredentialAcceptedMessage
  | CredentialRejectedMessage
  | PresentationRequestMessage
  | WalletLinkMessage
  | ProofAccessRequestMessage
  | ProofAccessResponseMessage
  | DIDCommInboundMessage
  | PushPresentationMessage
  | CredentialApiRequestMessage
  | DidSyncMessage
  | KeyRotateMessage
  | KeyBackupMessage
  | KeyRestoreMessage
  | PaymentRequestMessage
  | SignDocumentRequestMessage

// ── Helpers ──────────────────────────────────────────

/**
 * Send a typed message to the background service worker.
 */
export async function sendToBackground<T = unknown>(
  message: ExtensionMessage,
): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>
}

/**
 * Send a typed message to a specific tab's content script.
 */
export async function sendToTab<T = unknown>(
  tabId: number,
  message: ExtensionMessage,
): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>
}
