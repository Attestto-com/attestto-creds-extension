import { describe, it, expect, beforeEach } from 'vitest'
import { homographState, containsPunycode } from './homograph'
import { _resetRegistryCacheForTesting } from './trust-registry'

describe('homograph', () => {
  beforeEach(() => {
    _resetRegistryCacheForTesting()
  })

  describe('containsPunycode', () => {
    it('detects xn-- label', () => {
      expect(containsPunycode('xn--bcr-7s9b.com')).toBe(true)
      expect(containsPunycode('test.xn--p1ai')).toBe(true)
    })

    it('returns false for plain ASCII', () => {
      expect(containsPunycode('bccr.fi.cr')).toBe(false)
      expect(containsPunycode('example.com')).toBe(false)
    })
  })

  describe('homographState', () => {
    it('returns null for canonical registered hosts', async () => {
      expect(await homographState('bccr.fi.cr')).toBeNull()
      expect(await homographState('www.bccr.fi.cr')).toBeNull()
      expect(await homographState('ccss.sa.cr')).toBeNull()
    })

    it('flags brand-squat as red (registered brand on non-canonical host)', async () => {
      expect(await homographState('bccr.online')).toBe('red')
      expect(await homographState('bccr.com')).toBe('red')
      expect(await homographState('bccr.net')).toBe('red')
      expect(await homographState('ccss.com')).toBe('red')
    })

    it('flags punycode as yellow-heuristic', async () => {
      expect(await homographState('xn--bcr-7s9b.com')).toBe('yellow-heuristic')
    })

    it('returns null for unrelated ASCII hosts', async () => {
      expect(await homographState('example.com')).toBeNull()
      expect(await homographState('google.com')).toBeNull()
      expect(await homographState('github.com')).toBeNull()
    })

    it('returns null for empty input', async () => {
      expect(await homographState(null)).toBeNull()
      expect(await homographState(undefined)).toBeNull()
      expect(await homographState('')).toBeNull()
    })
  })
})
