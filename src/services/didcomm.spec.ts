import { describe, it, expect } from 'vitest'
import { parseProofRequest } from './didcomm'

describe('DIDComm v2 — parseProofRequest', () => {
  const validRequest = {
    id: 'req-001',
    type: 'https://didcomm.org/present-proof/3.0/request-presentation',
    from: 'did:sns:verifier.attestto',
    to: ['did:key:zHolder123'],
    created_time: Math.floor(Date.now() / 1000),
    body: {
      goal_code: 'verify-identity',
      comment: 'KYC compliance check',
      will_confirm: true,
      formats: [{
        attach_id: 'request-0',
        format: 'dif/presentation-exchange/v2@v2.0',
      }],
      request_presentations_attach: [{
        id: 'request-0',
        media_type: 'application/json',
        data: {
          nonce: 'abc123',
          requestedFields: ['full_name', 'document_country'],
          audience: 'did:sns:verifier.attestto',
        },
      }],
    },
  }

  it('parses a valid proof request', () => {
    const parsed = parseProofRequest(validRequest)

    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe('req-001')
    expect(parsed!.from).toBe('did:sns:verifier.attestto')
    expect(parsed!.nonce).toBe('abc123')
    expect(parsed!.requestedFields).toEqual(['full_name', 'document_country'])
    expect(parsed!.audience).toBe('did:sns:verifier.attestto')
    expect(parsed!.comment).toBe('KYC compliance check')
  })

  it('returns null for non-proof-request type', () => {
    const wrong = { ...validRequest, type: 'https://didcomm.org/other/1.0/message' }
    expect(parseProofRequest(wrong)).toBeNull()
  })

  it('returns null for missing attachments', () => {
    const noAttach = {
      ...validRequest,
      body: { ...validRequest.body, request_presentations_attach: [] },
    }
    expect(parseProofRequest(noAttach)).toBeNull()
  })

  it('returns null for null input', () => {
    expect(parseProofRequest(null)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(parseProofRequest('string')).toBeNull()
  })

  it('defaults audience to from when not specified', () => {
    const noAudience = JSON.parse(JSON.stringify(validRequest))
    delete noAudience.body.request_presentations_attach[0].data.audience
    const parsed = parseProofRequest(noAudience)

    expect(parsed!.audience).toBe('did:sns:verifier.attestto')
  })

  it('returns null when attachment has no data', () => {
    const noData = JSON.parse(JSON.stringify(validRequest))
    delete noData.body.request_presentations_attach[0].data
    expect(parseProofRequest(noData)).toBeNull()
  })

  it('defaults nonce, requestedFields, and comment when missing', () => {
    const minimal = JSON.parse(JSON.stringify(validRequest))
    delete minimal.body.request_presentations_attach[0].data.nonce
    delete minimal.body.request_presentations_attach[0].data.requestedFields
    delete minimal.body.comment

    const parsed = parseProofRequest(minimal)
    expect(parsed!.nonce).toBe('')
    expect(parsed!.requestedFields).toEqual([])
    expect(parsed!.comment).toBe('')
  })
})
