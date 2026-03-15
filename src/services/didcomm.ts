/**
 * DIDComm v2 message handler — P2P encrypted channel with verifiers.
 *
 * Implements the Present Proof 3.0 protocol (Aries RFC 0454):
 *   1. Receive request-presentation from verifier
 *   2. Build consent popup data (requested fields)
 *   3. On user approval, create partial SD-JWT presentation
 *   4. Send presentation back via the same channel
 *
 * Transport: The verifier's DIDComm endpoint is resolved from their DID.
 * Encryption: X25519 ECDH-ES+A256KW key agreement (JWE envelope).
 *
 * NOTE: This is a logical handler — the actual encrypted transport
 * will use the platform relay in Phase 6. Direct P2P requires
 * WebSocket or HTTP endpoint exchange, which is Phase 4+ scope.
 */

import type { DIDCommMessage, DIDCommProofRequest } from '@/types/credential'

// ── DIDComm v2 Message Types ─────────────────────────────

const PRESENT_PROOF_REQUEST = 'https://didcomm.org/present-proof/3.0/request-presentation'
const PRESENT_PROOF_RESPONSE = 'https://didcomm.org/present-proof/3.0/presentation'
const PRESENT_PROOF_PROBLEM = 'https://didcomm.org/present-proof/3.0/problem-report'

export interface DIDCommPresentationResponse extends DIDCommMessage {
  type: typeof PRESENT_PROOF_RESPONSE
  body: {
    goal_code: 'verify-identity'
    formats: Array<{
      attach_id: string
      format: string
    }>
    presentations_attach: Array<{
      id: string
      media_type: string
      data: {
        json?: Record<string, unknown>
        base64?: string
      }
    }>
  }
}

export interface ParsedProofRequest {
  id: string
  from: string
  nonce: string
  requestedFields: string[]
  audience: string
  comment: string
}

// ── Parsing ──────────────────────────────────────────────

/**
 * Parse a DIDComm v2 message and extract proof request data.
 * Returns null if the message is not a valid proof request.
 */
export function parseProofRequest(message: unknown): ParsedProofRequest | null {
  if (!message || typeof message !== 'object') return null

  const msg = message as DIDCommProofRequest
  if (msg.type !== PRESENT_PROOF_REQUEST) return null
  if (!msg.body?.request_presentations_attach?.length) return null

  const attach = msg.body.request_presentations_attach[0]
  if (!attach?.data) return null

  return {
    id: msg.id,
    from: msg.from,
    nonce: attach.data.nonce ?? '',
    requestedFields: attach.data.requestedFields ?? [],
    audience: attach.data.audience ?? msg.from,
    comment: msg.body.comment ?? '',
  }
}

/**
 * Build a DIDComm v2 presentation response message.
 */
export function buildPresentationResponse(
  requestId: string,
  from: string,
  to: string,
  presentation: string,
  format: 'sd-jwt' | 'json-ld',
): DIDCommPresentationResponse {
  const attachFormat = format === 'sd-jwt'
    ? 'dif/presentation-exchange/v2@v2.0'
    : 'aries/ld-proof-vc-detail@v2.0'

  return {
    id: `${requestId}-response`,
    type: PRESENT_PROOF_RESPONSE,
    from,
    to: [to],
    created_time: Math.floor(Date.now() / 1000),
    body: {
      goal_code: 'verify-identity',
      formats: [{
        attach_id: 'presentation-0',
        format: attachFormat,
      }],
      presentations_attach: [{
        id: 'presentation-0',
        media_type: format === 'sd-jwt' ? 'application/sd-jwt' : 'application/ld+json',
        data: format === 'sd-jwt'
          ? { base64: btoa(presentation) }
          : { json: JSON.parse(presentation) },
      }],
    },
  }
}

/**
 * Build a DIDComm v2 problem report (decline/error).
 */
export function buildProblemReport(
  requestId: string,
  from: string,
  to: string,
  code: 'e.p.user-declined' | 'e.p.credential-not-found' | 'e.p.internal-error',
  comment: string,
): DIDCommMessage {
  return {
    id: `${requestId}-problem`,
    type: PRESENT_PROOF_PROBLEM,
    from,
    to: [to],
    created_time: Math.floor(Date.now() / 1000),
    body: {
      code,
      comment,
    },
  }
}
