import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * Regression guard for the "no identity -> dead-end, popup never opens" bug.
 *
 * A fail-fast was once added to `handleAuthRequest` / `handleCwAuthRequest`
 * that replied to the page with a "No Digital ID found" error and returned
 * WITHOUT opening the approval popup — so a user with no Digital ID hit a dead
 * end and could never sign in. The popup's Create-DID state
 * (`entrypoints/approval/App.vue`, `createDidAndRetry` -> `wallet.createDid`)
 * is the flow that lets them mint one and finish sign-in, but it only runs if
 * the handler actually opens the popup.
 *
 * These handlers live inside the `defineBackground()` service-worker closure
 * (not exported / not unit-testable in isolation), and the file cannot be
 * placed under `src/entrypoints/` (WXT would treat a spec as an entrypoint), so
 * we guard the source: both auth handlers MUST call `openAuthApprovalWindow`
 * and MUST NOT short-circuit with a "No Digital ID found" message.
 */
const backgroundSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'entrypoints/background.ts'),
  'utf8',
)

function handlerBody(fnName: string, endMarker: string): string {
  const start = backgroundSrc.indexOf(`async function ${fnName}`)
  expect(start, `${fnName} not found in background.ts`).toBeGreaterThan(-1)
  const end = backgroundSrc.indexOf(endMarker, start)
  return backgroundSrc.slice(start, end === -1 ? undefined : end)
}

describe('auth handlers do not dead-end when no identity exists', () => {
  it('handleAuthRequest opens the approval popup and never fails fast on missing identity', () => {
    const body = handlerBody('handleAuthRequest', 'async function openAuthApprovalWindow')
    expect(body).toContain('openAuthApprovalWindow(')
    expect(body).not.toMatch(/No Digital ID found/)
  })

  it('handleCwAuthRequest opens the approval popup and never fails fast on missing identity', () => {
    const body = handlerBody('handleCwAuthRequest', 'function sendAuthErrorToTab')
    expect(body).toContain('openAuthApprovalWindow(')
    expect(body).not.toMatch(/No Digital ID found/)
  })
})
