import { describe, it, expect } from 'vitest'
import { normalizeOrigin, generateSiteDid, findOrCreateSiteDid, publicJwkOf } from './site-did'

describe('normalizeOrigin', () => {
  it('reduces a full URL to protocol//host', () => {
    expect(normalizeOrigin('https://bank.example.com/login?x=1')).toBe('https://bank.example.com')
  })

  it('keeps the port', () => {
    expect(normalizeOrigin('http://localhost:4321/anything')).toBe('http://localhost:4321')
  })

  it('collapses different paths on the same host to one key', () => {
    expect(normalizeOrigin('https://x.com/a')).toBe(normalizeOrigin('https://x.com/b'))
  })

  it('returns null for empty or invalid input', () => {
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin(null)).toBeNull()
    expect(normalizeOrigin(undefined)).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('generateSiteDid', () => {
  it('mints a did:jwk entry with a private key and timestamp', async () => {
    const entry = await generateSiteDid()
    expect(entry.did).toMatch(/^did:jwk:/)
    expect(entry.privateKeyJwk.kty).toBe('EC')
    expect(entry.privateKeyJwk.crv).toBe('P-256')
    expect(entry.privateKeyJwk.d).toBeTruthy() // private component present
    expect(typeof entry.createdAt).toBe('string')
  })

  it('mints a unique DID each call (pairwise, no reuse)', async () => {
    const a = await generateSiteDid()
    const b = await generateSiteDid()
    expect(a.did).not.toBe(b.did)
  })
})

describe('findOrCreateSiteDid', () => {
  it('creates a DID for a new origin', async () => {
    const res = await findOrCreateSiteDid(undefined, 'https://new.example.com/path')
    expect(res.created).toBe(true)
    expect(res.key).toBe('https://new.example.com')
    expect(res.siteDids['https://new.example.com']).toBe(res.entry)
    expect(res.entry.did).toMatch(/^did:jwk:/)
  })

  it('finds the existing DID for a returning origin (no new mint)', async () => {
    const first = await findOrCreateSiteDid(undefined, 'https://bank.example.com/x')
    const second = await findOrCreateSiteDid(first.siteDids, 'https://bank.example.com/y')
    expect(second.created).toBe(false)
    expect(second.entry.did).toBe(first.entry.did)
  })

  it('gives different origins different DIDs (no cross-site correlation)', async () => {
    const a = await findOrCreateSiteDid(undefined, 'https://a.example.com')
    const b = await findOrCreateSiteDid(a.siteDids, 'https://b.example.com')
    expect(b.entry.did).not.toBe(a.entry.did)
    expect(Object.keys(b.siteDids)).toHaveLength(2)
  })

  it('throws on an invalid origin', async () => {
    await expect(findOrCreateSiteDid(undefined, 'garbage')).rejects.toThrow()
  })
})

describe('publicJwkOf', () => {
  it('strips the private component', async () => {
    const entry = await generateSiteDid()
    const pub = publicJwkOf(entry)
    expect(pub).toEqual({
      kty: entry.privateKeyJwk.kty,
      crv: entry.privateKeyJwk.crv,
      x: entry.privateKeyJwk.x,
      y: entry.privateKeyJwk.y,
    })
    expect((pub as Record<string, unknown>).d).toBeUndefined()
  })
})
