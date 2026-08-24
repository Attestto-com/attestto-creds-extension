/**
 * Story 1.13 exit criterion — `background.ts` is a composition root and stays one.
 *
 * Two halves, and the first is the one that makes the second mean anything:
 *
 *  1. Each rule is run against a synthetic source that VIOLATES it, and against
 *     one that does not. A guard proven only against the file it guards has an
 *     untested failure mode — it might be incapable of failing, which is how a
 *     green suite ends up asserting nothing (the pattern this repo keeps hitting).
 *  2. The rules are then run against the real entrypoint.
 *
 * The violating fixtures are lifted from what this file ACTUALLY contained
 * before Story 1.13, not invented: the sd-jwt parse, the duplicated
 * `crypto.subtle.generateKey`, the hand-written envelope, the read-mutate-write.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  noDomainServiceImports,
  noCryptoPrimitives,
  noWireEnvelopes,
  noVaultMutation,
  caseClauseBudget,
  compositionRootRules,
  measureCaseClauses,
} from './composition-root-rules'

// Resolved from the vitest root (the package dir), not from import.meta.url —
// the spec runs transformed, so a URL relative to the module is not a file URL.
const ENTRYPOINT = resolve(process.cwd(), 'src/entrypoints/background.ts')
const source = readFileSync(ENTRYPOINT, 'utf8')

/**
 * The ceiling the migration left behind. The largest case is AUTH_APPROVE at 23
 * statements — ctx plumbing and transport for a two-protocol flow. Raising this
 * number is a decision to be argued in review, which is the point of pinning it.
 */
const MAX_CASE_STATEMENTS = 25

describe('the rules can fail (proven on violating fixtures)', () => {
  it('catches a domain service imported into the entrypoint', () => {
    const violating = `import { parseSdJwt } from '@/services/sdjwt'\nexport default defineBackground(() => {})\n`
    const clean = `import { handleKeyRotate } from '@/background/handlers/key-rotate.handler'\n`

    expect(noDomainServiceImports(violating).violations).toHaveLength(1)
    expect(noDomainServiceImports(violating).violations[0]).toMatchObject({ line: 1, detail: '@/services/sdjwt' })
    expect(noDomainServiceImports(clean).violations).toEqual([])
  })

  it('catches a crypto primitive reached from the entrypoint', () => {
    // Verbatim shape of what lived here until Phase 11, in two copies.
    const violating = `
      const keygen = async () => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
        return crypto.subtle.exportKey('jwk', kp.privateKey)
      }
    `
    const clean = `const keyAdminAdapters = createKeyAdminAdapters({ readVault, writeVault, syncPublicVault })`

    expect(noCryptoPrimitives(violating).violations).toHaveLength(2)
    expect(noCryptoPrimitives(clean).violations).toEqual([])
  })

  it('catches a hand-written wire envelope', () => {
    const viaHelper = `notifyTab(tabId, { type: 'AUTH_RESPONSE', payload: { requestId, error } })`
    const viaChrome = `chrome.tabs.sendMessage(tabId, { type: 'AUTH_RESPONSE', payload: {} })`
    const clean = `sendAuthErrorToTab(senderTabId, requestId, 'User declined')`

    expect(noWireEnvelopes(viaHelper).violations[0]).toMatchObject({ detail: 'notifyTab' })
    expect(noWireEnvelopes(viaChrome).violations[0]).toMatchObject({ detail: 'chrome.tabs.sendMessage' })
    expect(noWireEnvelopes(clean).violations).toEqual([])
    // chrome.runtime.sendMessage is wiring, not a page envelope — must not trip.
    expect(noWireEnvelopes(`chrome.runtime.sendMessage({ type: 'X' })`).violations).toEqual([])
  })

  it('catches read-mutate-write against the vault', () => {
    const violating = `
      readVault().then(async (vault) => {
        vault.proofRequests = [...(vault.proofRequests ?? []), record]
        vault.linkedSolanaAddress = address
        await writeVault(vault)
      })
    `
    const clean = `const vaultRecordStore = { read: () => readVault(), write: (v) => writeVault(v) }`

    expect(noVaultMutation(violating).violations.map((v) => v.detail)).toEqual([
      'vault.proofRequests',
      'vault.linkedSolanaAddress',
    ])
    expect(noVaultMutation(clean).violations).toEqual([])
  })

  it('catches a case clause that grew past the budget', () => {
    const body = Array.from({ length: 30 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const violating = `switch (m.type) { case 'BIG': { ${body} \n break } }`
    const clean = `switch (m.type) { case 'SMALL': { const a = 1; break } }`

    expect(caseClauseBudget(violating, MAX_CASE_STATEMENTS).violations).toHaveLength(1)
    expect(caseClauseBudget(violating, MAX_CASE_STATEMENTS).violations[0].detail).toContain("'BIG'")
    expect(caseClauseBudget(clean, MAX_CASE_STATEMENTS).violations).toEqual([])
  })

  it('a fixture carrying EVERY violation trips every rule — no rule silently shadows another', () => {
    const kitchenSink = `
      import { parseSdJwt } from '@/services/sdjwt'
      const k = await crypto.subtle.generateKey({}, true, [])
      notifyTab(tabId, { type: 'X', payload: {} })
      vault.credentials = [...vault.credentials, c]
    `
    const failing = compositionRootRules(kitchenSink).filter((r) => r.violations.length > 0)
    expect(failing.map((r) => r.rule).sort()).toEqual([
      'no-crypto-primitives',
      'no-domain-service-imports',
      'no-vault-mutation',
      'no-wire-envelopes',
    ])
  })
})

describe('background.ts is a composition root', () => {
  it.each(compositionRootRules(source))('$rule — $because', ({ violations }) => {
    expect(violations).toEqual([])
  })

  it('no message case has grown past the budget the migration left', () => {
    const result = caseClauseBudget(source, MAX_CASE_STATEMENTS)
    expect(result.violations).toEqual([])
  })

  it('the budget is a real constraint, not slack — the largest case is near it', () => {
    // If this fails upward, the entrypoint shrank and MAX_CASE_STATEMENTS should
    // come down with it. A ceiling far above the actual maximum guards nothing.
    const largest = measureCaseClauses(source)[0]
    expect(largest.statements).toBeGreaterThan(MAX_CASE_STATEMENTS - 10)
    expect(largest.statements).toBeLessThanOrEqual(MAX_CASE_STATEMENTS)
  })

  it('the switch still routes every message — the rules did not pass by deletion', () => {
    // A file that dispatched nothing would satisfy every rule above. It must not.
    // 38, down from 40: SOC-277 removed LIST_STORED_CREDENTIALS and
    // RESHARE_STORED_VP — the two page-facing vault READS. The floor tracks
    // reality so this stays a real constraint; the intent (a file that
    // dispatches nothing satisfies every other rule) is unchanged.
    const cases = measureCaseClauses(source)
    expect(cases.length).toBeGreaterThanOrEqual(38)
  })
})
