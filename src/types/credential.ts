export type CredentialFormat = 'sd-jwt' | 'json-ld'

export interface StoredCredential {
  id: string
  format: CredentialFormat
  raw: string
  issuer: string
  issuedAt: string
  expiresAt: string | null
  types: string[]
  decodedClaims: Record<string, unknown>
  metadata: {
    addedAt: string
    source: 'push' | 'manual'
    disclosureDigests?: string[]
  }
}

// ── Share A (Shamir key share) ──────────────────────────

export interface StoredKeyShare {
  credentialId: string
  shareA: string // base64url-encoded XOR share
  createdAt: string
}

// ── Proof Access Requests ───────────────────────────────

export type ProofRequestStatus = 'pending' | 'approved' | 'declined' | 'expired'

export interface ProofAccessRequest {
  id: string
  credentialId: string
  requesterDid: string
  requesterName: string
  purpose: string
  requestedFields: string[]
  approvedFields: string[]
  status: ProofRequestStatus
  receivedAt: string
  decidedAt: string | null
  expiresAt: string | null
  transport: 'platform' | 'didcomm_v2' | 'push_to_vault'
  nonce: string
  audience: string
}

// ── Prepared Presentations (Push-then-Present) ──────────

export interface PreparedPresentation {
  id: string
  credentialId: string
  presentation: string // signed SD-JWT or JSON-LD VP
  selectedFields: string[]
  createdAt: string
  expiresAt: string
  used: boolean
  usedAt: string | null
}

// ── DIDComm v2 ──────────────────────────────────────────

export interface DIDCommMessage {
  id: string
  type: string
  from: string
  to: string[]
  created_time: number
  body: Record<string, unknown>
}

export interface DIDCommProofRequest extends DIDCommMessage {
  type: 'https://didcomm.org/present-proof/3.0/request-presentation'
  body: {
    goal_code: 'verify-identity'
    comment: string
    will_confirm: boolean
    formats: Array<{
      attach_id: string
      format: 'dif/presentation-exchange/v2@v2.0'
    }>
    request_presentations_attach: Array<{
      id: string
      media_type: 'application/json'
      data: {
        nonce: string
        requestedFields: string[]
        audience: string
      }
    }>
  }
}
