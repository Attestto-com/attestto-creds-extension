import { describe, it, expect } from 'vitest'
import { platformOrigins, isPlatformOrigin } from './platform-origins'

describe('platform-origins', () => {
  it('includes the canonical platform origin', () => {
    // PLATFORM_URL defaults to https://app.attestto.com when VITE_PLATFORM_URL is unset.
    expect(platformOrigins()).toContain('https://app.attestto.com')
  })

  it('accepts the canonical platform origin', () => {
    expect(isPlatformOrigin('https://app.attestto.com')).toBe(true)
  })

  it('accepts the platform origin even when a path/query is supplied', () => {
    expect(isPlatformOrigin('https://app.attestto.com/onboarding?x=1')).toBe(true)
  })

  it('rejects an arbitrary HTTPS origin', () => {
    expect(isPlatformOrigin('https://evil.example.com')).toBe(false)
  })

  it('rejects a look-alike host', () => {
    expect(isPlatformOrigin('https://app.attestto.com.evil.example')).toBe(false)
  })

  it('rejects null / undefined / malformed input', () => {
    expect(isPlatformOrigin(null)).toBe(false)
    expect(isPlatformOrigin(undefined)).toBe(false)
    expect(isPlatformOrigin('')).toBe(false)
    expect(isPlatformOrigin('not-a-url')).toBe(false)
  })

  it('allows localhost only in dev builds', () => {
    // Dev convenience: localhost is a platform origin iff import.meta.env.DEV.
    expect(isPlatformOrigin('http://localhost:5173')).toBe(Boolean(import.meta.env.DEV))
    expect(isPlatformOrigin('http://127.0.0.1:3000')).toBe(Boolean(import.meta.env.DEV))
  })
})
