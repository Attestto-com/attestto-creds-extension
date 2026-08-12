/**
 * Inbound proof-request parsing.
 *
 * Honest surface (Story 1.8): this module borrows DIDComm/Present-Proof-3.0
 * message-type vocabulary but implements NONE of the DIDComm wire mechanics —
 * there is no JWE envelope, no X25519 key agreement, no DID-endpoint resolution,
 * no encrypted transport. It only reads fields off an already-received plain
 * message. Earlier docs claimed a "P2P encrypted channel / implements Present
 * Proof 3.0"; that was borrowed vocabulary, never a protocol. The real inbound
 * transport is REST + DIF Presentation Exchange and is rebuilt in Epic 2 (OID4VP);
 * the `DIDCOMM_INBOUND` route that calls `parseProofRequest` is characterized in
 * Story 1.9 before that rework, which is why the parser is kept here.
 *
 * The response/problem-report builders that previously lived here were dead
 * (zero production callsites — tested placeholders) and were retired in Story 1.8.
 */

import type { DIDCommProofRequest } from '@/types/credential'

/** The inbound message type this parser recognizes (Present-Proof request shape). */
const PRESENT_PROOF_REQUEST = 'https://didcomm.org/present-proof/3.0/request-presentation'

export interface ParsedProofRequest {
  id: string
  from: string
  nonce: string
  requestedFields: string[]
  audience: string
  comment: string
}

/**
 * Parse an inbound proof-request message and extract the request data.
 * Returns null if the message is not a well-formed proof request.
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
