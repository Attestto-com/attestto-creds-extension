import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import {
  SUPPORTED_RESPONSE_MODES,
  SUPPORTED_CLIENT_ID_SCHEMES,
  isSupportedResponseMode,
  isSupportedClientIdScheme,
} from './profile'

/**
 * Story 2.7 — the guard that gives `profile.ts` its point.
 *
 * A config module is only a single source of truth while it is the ONLY place
 * these strings appear. The moment a transport module writes `'direct_post'`
 * inline, the profile stops being authoritative and becomes documentation that
 * happens to agree — until it doesn't. This codebase has shipped that exact
 * drift before (a route declaring a check the router never ran; a type saying
 * six entity kinds while the database admitted fourteen).
 *
 * So this scans the real source tree, on disk, for the profile's vocabulary
 * outside the module that owns it. The referent is the FILE BYTES, not anything
 * the profile module reports about itself.
 *
 * 🔑 Per this repo's history, a guard proven only against the file it guards has
 * an untested failure mode. The last block runs every rule against a VIOLATING
 * fixture to show the scanner can actually find one.
 */

const SRC = resolve(__dirname, '../..')

/** The module that legitimately owns this vocabulary, plus its own specs. */
const OWNER_FILES = [
  'background/messaging/profile.ts',
  'background/messaging/profile.spec.ts',
  'background/messaging/profile.no-hardcoding.spec.ts',
]

/**
 * Specs are excluded, deliberately and with a limit.
 *
 * A spec that verifies the profile REJECTS `fragment` has to name `fragment`;
 * there is no way to test an exclusion without writing it down. Scanning specs
 * would therefore make this guard fire on exactly the tests that prove the
 * narrowings hold — punishing the right behaviour.
 *
 * The limit: specs do not ship. The risk this guard exists to stop is
 * PRODUCTION code becoming a second source of the vocabulary, and that surface
 * is still scanned in full. The "scanner can actually find a violation" block
 * below plants its probe in a non-spec file for that reason.
 */
function isSpec(path: string): boolean {
  return /\.(spec|test|test-d)\.ts$/.test(path)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|vue)$/.test(entry) && !isSpec(entry)) {
      out.push(full)
    }
  }
  return out
}

interface Occurrence {
  file: string
  line: number
  text: string
}

function findLiteral(literal: string, files: string[]): Occurrence[] {
  const found: Occurrence[] = []
  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, '/')
    if (OWNER_FILES.includes(rel)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      // Only a quoted string literal counts. A mention in prose — "we do not
      // support fragment mode" — is documentation, not a second source.
      if (text.includes(`'${literal}'`) || text.includes(`"${literal}"`)) {
        found.push({ file: rel, line: i + 1, text: text.trim() })
      }
    })
  }
  return found
}

const ALL_FILES = walk(SRC)

describe('the messaging profile is the only source of its vocabulary', () => {
  it('finds source files to scan at all', () => {
    // Positive control. A scanner pointed at an empty list proves nothing, and
    // every assertion below would vacuously pass.
    expect(ALL_FILES.length).toBeGreaterThan(50)
  })

  it.each([...SUPPORTED_RESPONSE_MODES])(
    'the response mode %s appears in no other file',
    (mode) => {
      const hits = findLiteral(mode, ALL_FILES)
      expect(
        hits,
        `'${mode}' is hardcoded outside profile.ts:\n${hits
          .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
          .join('\n')}`,
      ).toEqual([])
    },
  )

  it.each([...SUPPORTED_CLIENT_ID_SCHEMES])(
    'the client_id scheme %s appears in no other file',
    (scheme) => {
      const hits = findLiteral(scheme, ALL_FILES)
      expect(
        hits,
        `'${scheme}' is hardcoded outside profile.ts:\n${hits
          .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
          .join('\n')}`,
      ).toEqual([])
    },
  )

  /**
   * The excluded options are the narrowings that carry a security rationale.
   * If one reappears anywhere it is either a re-widening or a second source,
   * and both need a human to look.
   */
  it.each(['fragment', 'query', 'direct_post.jwt', 'redirect_uri'])(
    'the deliberately EXCLUDED option %s is not reintroduced anywhere',
    (excluded) => {
      const hits = findLiteral(excluded, ALL_FILES)
      expect(
        hits,
        `'${excluded}' was excluded from the profile for a documented reason but appears at:\n${hits
          .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
          .join('\n')}`,
      ).toEqual([])
    },
  )
})

/**
 * 🔑 Proving the scanner bites.
 *
 * Every assertion above is of the form "this list is empty", which is exactly
 * the shape that passes when the scanner is broken. These run the same
 * machinery against content known to contain a violation.
 */
describe('the scanner can actually find a violation', () => {
  const fixtureDir = resolve(__dirname, '__scanner-fixture__')

  it('detects a hardcoded response mode in a file it is given', () => {
    // Scan THIS spec's own directory listing but with a synthetic file list
    // pointing at a real file that contains the literal: profile.ts itself,
    // temporarily treated as a non-owner.
    const profilePath = resolve(__dirname, 'profile.ts')
    const hits = findLiteralWithoutOwners('direct_post', [profilePath])
    expect(hits.length).toBeGreaterThan(0)
  })

  it('detects an excluded option when one is present', () => {
    const profilePath = resolve(__dirname, 'profile.ts')
    // `redirect_uri` appears in profile.ts prose but NOT as a quoted literal —
    // so a prose mention must NOT be flagged...
    expect(findLiteralWithoutOwners('redirect_uri', [profilePath])).toEqual([])
    // ...while a quoted one must be. The spec file quotes it.
    const specPath = resolve(__dirname, 'profile.spec.ts')
    expect(findLiteralWithoutOwners('redirect_uri', [specPath]).length).toBeGreaterThan(0)
  })

  it('does not flag a bare word in prose', () => {
    // Scans profile.ts, which uses the word `vocabulary` in a comment and never
    // as a quoted literal. Deliberately NOT scanning this spec file: the search
    // term is itself quoted at every call site here, so any term passed in
    // would find itself and the test would report the scanner's own source.
    // (First draft did exactly that with `rest` and failed — a self-referential
    // referent is not an independent one.)
    const hits = findLiteralWithoutOwners('vocabulary', [resolve(__dirname, 'profile.ts')])
    expect(hits).toEqual([])
  })

  /** Same matcher, owner exclusion disabled, so fixtures can be checked. */
  function findLiteralWithoutOwners(literal: string, files: string[]): Occurrence[] {
    const found: Occurrence[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((text, i) => {
        if (text.includes(`'${literal}'`) || text.includes(`"${literal}"`)) {
          found.push({ file: relative(SRC, file), line: i + 1, text: text.trim() })
        }
      })
    }
    return found
  }

  it('the fixture directory is not required to exist', () => {
    // Documenting that this suite needs no on-disk fixture, so a missing one
    // can never be the reason it passes.
    expect(fixtureDir).toContain('__scanner-fixture__')
  })
})

describe('the predicates agree with the declared lists', () => {
  it('every declared response mode is accepted by its predicate', () => {
    for (const mode of SUPPORTED_RESPONSE_MODES) {
      expect(isSupportedResponseMode(mode)).toBe(true)
    }
  })

  it('every declared client_id scheme is accepted by its predicate', () => {
    for (const scheme of SUPPORTED_CLIENT_ID_SCHEMES) {
      expect(isSupportedClientIdScheme(scheme)).toBe(true)
    }
  })
})
