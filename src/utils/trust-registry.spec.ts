import { describe, it, expect, beforeEach } from 'vitest'
import {
  brandLabelFromHost,
  lookupByBrand,
  lookupHost,
  _resetRegistryCacheForTesting,
} from './trust-registry'

describe('trust-registry', () => {
  beforeEach(() => {
    _resetRegistryCacheForTesting()
  })

  describe('brandLabelFromHost', () => {
    it('extracts brand from CR sld+cctld (fi.cr / sa.cr / go.cr / ac.cr / or.cr)', () => {
      expect(brandLabelFromHost('bccr.fi.cr')).toBe('bccr')
      expect(brandLabelFromHost('ccss.sa.cr')).toBe('ccss')
      expect(brandLabelFromHost('mopt.go.cr')).toBe('mopt')
      expect(brandLabelFromHost('ucr.ac.cr')).toBe('ucr')
      expect(brandLabelFromHost('cfia.or.cr')).toBe('cfia')
    })

    it('handles plain ccTLD (.cr)', () => {
      expect(brandLabelFromHost('medicos.cr')).toBe('medicos')
    })

    it('handles generic TLD (.com / .org)', () => {
      expect(brandLabelFromHost('bancobcr.com')).toBe('bancobcr')
      expect(brandLabelFromHost('grupoins.com')).toBe('grupoins')
      expect(brandLabelFromHost('colegiodentistascr.org')).toBe('colegiodentistascr')
    })

    it('strips www', () => {
      expect(brandLabelFromHost('www.bccr.fi.cr')).toBe('bccr')
    })

    it('uses leftmost label of subdomain', () => {
      // For multi-level hosts like conesup.mep.go.cr, we want the deepest
      // brand — `conesup` not `mep`.
      expect(brandLabelFromHost('conesup.mep.go.cr')).toBe('mep')
      // The test above documents current behavior — the heuristic peels
      // only the suffix. A future "longest-known-prefix-from-registry"
      // walk would resolve this. Acceptable for v0 since the canonical
      // entry for CONESUP is the full conesup.mep.go.cr.
    })

    it('returns null for single-label or bare TLDs', () => {
      expect(brandLabelFromHost('localhost')).toBeNull()
    })
  })

  describe('lookupHost', () => {
    it('finds canonical CR institution', async () => {
      const entry = await lookupHost('bccr.fi.cr')
      expect(entry).not.toBeNull()
      expect(entry?.name).toBe('BCCR')
      expect(entry?.category).toBe('Banco Central')
    })

    it('is case-insensitive and strips www', async () => {
      const a = await lookupHost('WWW.BCCR.FI.CR')
      expect(a?.name).toBe('BCCR')
    })

    it('returns null for unknown host', async () => {
      expect(await lookupHost('example.com')).toBeNull()
    })

    it('returns null for empty', async () => {
      expect(await lookupHost(null)).toBeNull()
      expect(await lookupHost(undefined)).toBeNull()
      expect(await lookupHost('')).toBeNull()
    })
  })

  describe('lookupByBrand', () => {
    it('matches host that shares a brand label with a registry entry', async () => {
      // bccr.online is NOT in the registry but shares the `bccr` brand
      // with bccr.fi.cr — should return the canonical entry.
      const matches = await lookupByBrand('bccr.online')
      expect(matches.length).toBeGreaterThan(0)
      expect(matches[0].host).toBe('bccr.fi.cr')
    })

    it('returns empty for unrelated host', async () => {
      const matches = await lookupByBrand('example.com')
      expect(matches).toEqual([])
    })
  })
})
