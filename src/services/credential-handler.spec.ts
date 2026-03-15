import { describe, it, expect } from 'vitest'
import { buildCredentialHandlerScript } from './credential-handler'

describe('Credential Handler Script', () => {
  it('returns a non-empty script string', () => {
    const script = buildCredentialHandlerScript()

    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(100)
  })

  it('contains navigator.credentials.get override', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('navigator.credentials.get')
  })

  it('contains attestto-creds-ready event dispatch', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('attestto-creds-ready')
  })

  it('contains credential-wallet:discover listener', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('credential-wallet:discover')
    expect(script).toContain('credential-wallet:announce')
  })

  it('contains CHAPI web.VerifiablePresentation interception', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('VerifiablePresentation')
    expect(script).toContain('chapiVP')
  })

  it('contains ATTESTTO_VP_REQUEST message type', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('ATTESTTO_VP_REQUEST')
  })

  it('contains ATTESTTO_VP_RESPONSE listener', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('ATTESTTO_VP_RESPONSE')
  })

  it('is wrapped in an IIFE for isolation', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toMatch(/^\(function\(\)\s*\{/)
    expect(script).toMatch(/\}\)\(\);$/)
  })

  it('uses strict mode', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain("'use strict'")
  })

  it('preserves original get for passthrough', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('originalGet')
  })

  it('includes 5-minute timeout', () => {
    const script = buildCredentialHandlerScript()

    expect(script).toContain('300000')
  })
})
