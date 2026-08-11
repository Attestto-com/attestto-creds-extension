#!/usr/bin/env node
/**
 * Story 1.18 — prove each quality gate can FAIL.
 *
 * This repo has now shipped three gates that reported green while checking
 * nothing:
 *
 *   - `type-check` ran `vue-tsc --noEmit` against a solution-style tsconfig
 *     (`files: []` + `references`); without `-b` it followed no references and
 *     checked an EMPTY FILE SET. `const x: number = "s"` sailed through, and it
 *     had been masking 24 real errors, two of them live runtime bugs.
 *   - `lint:check` ran `eslint .` with no config at all. It exited 2 on every
 *     run and CI was configured `continue-on-error: true`, so it could neither
 *     pass nor fail.
 *   - `test:run` had a spec making a real network call, so its colour depended
 *     on what was listening on port 3000.
 *
 * Every one of those was found by accident. A passing gate is not evidence; a
 * gate that has been SEEN to fail on a known-bad input is. So: for each gate,
 * write a file that violates exactly what that gate is for, run the gate, and
 * require a non-zero exit. Then delete the file and require zero.
 *
 * Run: `npm run gate-self-test`
 *
 * The seeded files are written under `src/` because that is the only place the
 * gates look, and are removed in a `finally` so a crash cannot leave a poisoned
 * tree behind. Nothing here is imported by the app.
 */
import { execSync } from 'node:child_process'
import { writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run a gate. Returns its exit code; never throws on a failing gate.
 *
 * `execSync` takes a shell string here deliberately and safely: every command is
 * a literal in the `GATES` table below, nothing is interpolated, and no value
 * from argv, the environment, or the filesystem reaches it.
 */
function runGate(command) {
  try {
    execSync(command, { cwd: ROOT, stdio: 'pipe' })
    return 0
  } catch (err) {
    return err.status ?? 1
  }
}

const GATES = [
  {
    name: 'type-check',
    command: 'npm run type-check',
    seedPath: 'src/__gate-self-test__.ts',
    // A type error a compiler cannot miss. If `type-check` passes with this in
    // the tree, it is not reading the tree.
    seed: `export const deliberatelyWrong: number = 'not a number'\n`,
  },
  {
    name: 'lint:check',
    command: 'npm run lint:check',
    seedPath: 'src/__gate-self-test__.ts',
    // A FLOATING PROMISE, not a style nit: the rule that actually protects this
    // codebase, and one `tsc` does not report. Seeding a formatting violation
    // would prove the linter runs but not that the rules we rely on are on.
    seed: `export function unhandled(): void {\n  Promise.resolve().then(() => undefined)\n}\n`,
  },
  {
    name: 'test:run',
    command: 'npm run test:run',
    seedPath: 'src/__gate-self-test__.spec.ts',
    seed: `import { describe, it, expect } from 'vitest'\n\ndescribe('gate self-test', () => {\n  it('fails on purpose', () => {\n    expect(1).toBe(2)\n  })\n})\n`,
  },
  {
    name: 'test:coverage',
    command: 'npm run test:coverage',
    // Seeded INSIDE src/services, which carries a 90% floor. A global-only
    // threshold could not notice one uncovered file among hundreds — that is
    // the argument for per-area floors, and this is the test of it.
    seedPath: 'src/services/__gate-self-test__.ts',
    // Untested branches, not merely untested lines: a file that only lowers
    // line coverage would prove less than one that also drags branches down,
    // and branch coverage is the number that actually degrades first.
    seed:
      `export function neverCalled(n: number): string {\n` +
      `  if (n > 10) return 'big'\n` +
      `  if (n > 5) return 'medium'\n` +
      `  if (n > 0) return 'small'\n` +
      `  return 'none'\n` +
      `}\n\n` +
      `export function alsoNeverCalled(items: string[]): string[] {\n` +
      `  return items.filter((i) => i.length > 0).map((i) => i.toUpperCase())\n` +
      `}\n`,
  },
]

let failures = 0

for (const gate of GATES) {
  const seedFile = resolve(ROOT, gate.seedPath)
  let seededExit
  try {
    writeFileSync(seedFile, gate.seed)
    seededExit = runGate(gate.command)
  } finally {
    rmSync(seedFile, { force: true })
  }

  if (seededExit === 0) {
    console.error(
      `✗ ${gate.name} PASSED on a deliberate violation — the gate is not checking.\n` +
        `  seeded: ${gate.seedPath}\n${gate.seed.split('\n').map((l) => `    ${l}`).join('\n')}`,
    )
    failures++
    continue
  }

  const cleanExit = runGate(gate.command)
  if (cleanExit !== 0) {
    console.error(
      `✗ ${gate.name} FAILED on a clean tree (exit ${cleanExit}) — it cannot tell ` +
        `a violation from the normal state, so its red means nothing either.`,
    )
    failures++
    continue
  }

  console.log(`✓ ${gate.name} — red on a violation (exit ${seededExit}), green when clean`)
}

// A crash mid-run must not leave a seeded file behind for the NEXT build to
// trip over; belt and braces on top of the per-gate `finally`.
for (const gate of GATES) {
  if (existsSync(resolve(ROOT, gate.seedPath))) rmSync(resolve(ROOT, gate.seedPath), { force: true })
}

if (failures > 0) {
  console.error(`\n${failures} gate(s) cannot be trusted.`)
  process.exit(1)
}
console.log(`\nAll ${GATES.length} gates proven to bite.`)
