import { describe, it, expect } from 'vitest'
import {
  parseProofRequest,
  buildPresentationResponse,
  buildProblemReport,
} from './didcomm'

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

describe('DIDComm v2 — buildPresentationResponse', () => {
  it('builds an SD-JWT presentation response', () => {
    const response = buildPresentationResponse(
      'req-001',
      'did:key:zHolder',
      'did:sns:verifier',
      'eyJhbGciOiJFUzI1NiJ9.test~disclosure1~',
      'sd-jwt',
    )

    expect(response.id).toBe('req-001-response')
    expect(response.type).toBe('https://didcomm.org/present-proof/3.0/presentation')
    expect(response.from).toBe('did:key:zHolder')
    expect(response.to).toEqual(['did:sns:verifier'])
    expect(response.body.presentations_attach[0].media_type).toBe('application/sd-jwt')
    expect(response.body.presentations_attach[0].data.base64).toBeTruthy()
  })

  it('builds a JSON-LD presentation response', () => {
    const vpJson = JSON.stringify({ type: 'VerifiablePresentation' })
    const response = buildPresentationResponse(
      'req-002',
      'did:key:zHolder',
      'did:sns:verifier',
      vpJson,
      'json-ld',
    )

    expect(response.body.presentations_attach[0].media_type).toBe('application/ld+json')
    expect(response.body.presentations_attach[0].data.json).toEqual({ type: 'VerifiablePresentation' })
  })
})

describe('DIDComm v2 — buildProblemReport', () => {
  it('builds a user-declined problem report', () => {
    const report = buildProblemReport(
      'req-001',
      'did:key:zHolder',
      'did:sns:verifier',
      'e.p.user-declined',
      'User declined the request',
    )

    expect(report.id).toBe('req-001-problem')
    expect(report.type).toBe('https://didcomm.org/present-proof/3.0/problem-report')
    expect(report.body.code).toBe('e.p.user-declined')
    expect(report.body.comment).toBe('User declined the request')
  })

  it('includes correct from/to', () => {
    const report = buildProblemReport(
      'req-002',
      'did:key:zA',
      'did:sns:zB',
      'e.p.credential-not-found',
      'No matching credential',
    )

    expect(report.from).toBe('did:key:zA')
    expect(report.to).toEqual(['did:sns:zB'])
  })
})
