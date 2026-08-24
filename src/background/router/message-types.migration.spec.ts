/**
 * MIGRATION GUARD — DELETE WITH THE LEGACY SWITCH IN STORY 1.13.
 *
 * Non-vacuous drift guard (logic party 2026-08-08). The `MessageType` union and
 * any hand-authored tag list share one author, so a list-equals-list test is a
 * mirror: it cannot catch a type the union forgot. The ONLY independent referent
 * for "which types are actually dispatched" is the real `switch (message.type)`
 * in `src/entrypoints/background.ts`.
 *
 * This test machine-extracts that switch's `case` labels from the TypeScript AST
 * (NOT a regex on source — a string match asserts text presence, the govscan
 * vacuous-green sin; an AST CaseClause node-set IS the referent) and asserts
 * `MessageType` ⊇ the dispatched set. When the switch is removed in Story 1.13
 * the registry becomes the authority and this guard is deleted, not repaired.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { MESSAGE_TYPES } from './message-types'

// Resolve from the vitest cwd (project root) to avoid vite rewriting
// `import.meta.url` to a browser `self.location` under the happy-dom env.
const BACKGROUND_PATH = resolve(process.cwd(), 'src/entrypoints/background.ts')

/**
 * Walk the AST, find every `switch` whose discriminant is `message.type`, and
 * collect the string-literal texts of its `case` clauses. Returns the union of
 * all such clauses (defensive: today there is exactly one such switch).
 */
function extractDispatchedCaseLabels(sourcePath: string): Set<string> {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  )
  const labels = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (
      ts.isSwitchStatement(node) &&
      node.expression.getText(source) === 'message.type'
    ) {
      for (const clause of node.caseBlock.clauses) {
        if (
          ts.isCaseClause(clause) &&
          ts.isStringLiteralLike(clause.expression)
        ) {
          labels.add(clause.expression.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return labels
}

describe('MIGRATION GUARD — delete with the legacy switch in Story 1.13', () => {
  const dispatched = extractDispatchedCaseLabels(BACKGROUND_PATH)

  it('extracts the real dispatched case labels from the switch AST (referent is non-empty)', () => {
    // Sanity on the referent itself: if extraction silently returns {} the
    // ⊇ assertion below would pass vacuously. Guard the guard.
    // 38 since SOC-277 removed the two page-facing vault reads.
    expect(dispatched.size).toBeGreaterThanOrEqual(38)
  })

  it('MessageType ⊇ every type the background switch dispatches', () => {
    const union = new Set<string>(MESSAGE_TYPES)
    const missingFromUnion = [...dispatched].filter((t) => !union.has(t)).sort()
    expect(missingFromUnion).toEqual([])
  })
})
