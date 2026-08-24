/**
 * background.ts — the composition root, at 0% coverage until this file.
 *
 * Story 1.13 took the service worker from 2374 to 1302 lines and moved 6,582
 * lines into `src/background/**`, where the specs hold them at 94–98%. What is
 * left is almost entirely WIRING: two `addListener` calls and a 42-case
 * `switch (message.type)`. None of it was executed by any test — v8 reported
 * lines 84–1297 uncovered — because nothing had ever imported the module.
 *
 * It turned out to be importable all along: `defineBackground` is a WXT
 * auto-import, so stubbing that one global is enough. The file was not
 * untestable; it was untested.
 *
 * ── What this file asserts, and what it deliberately does not ──────────────
 *
 * NOT the handlers. Their own specs cover them far better than a dispatch test
 * could, and re-asserting their behaviour here would be a second mirror of the
 * same author.
 *
 * What is unasserted anywhere else is REACHABILITY: that every case in the
 * switch can be entered and answers the caller. In MV3 a case that falls
 * through without calling `sendResponse` does not throw — the caller waits for
 * a reply that never comes and times out, which is indistinguishable from a
 * user who walked away. That is the failure mode this listener's own comment
 * describes finding 46 instances of, and it is invisible to every unit test of
 * every extracted handler.
 *
 * This repo has shipped the adjacent defect twice: `3215845` deleted three
 * unreachable surfaces, `8f3e947` a dead ungated signing path.
 *
 * ── The referent ───────────────────────────────────────────────────────────
 *
 * The type list is machine-extracted from the switch's own AST, not from
 * `MESSAGE_TYPES`. Driving the test off an authored list would let a case added
 * to the switch escape coverage forever; driving it off the AST means a new
 * `case` is covered the moment it is written. (Same reasoning, and the same
 * helper, as `router/message-types.migration.spec.ts` — which asserts the two
 * SETS agree. Set agreement is not reachability: 42 = 42 today, and that says
 * nothing about whether any of the 42 answers.)
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const BACKGROUND_PATH = resolve(process.cwd(), 'src/entrypoints/background.ts')

/** Every string `case` label of the `switch (message.type)` in background.ts. */
function dispatchedTypes(): string[] {
  const source = ts.createSourceFile(
    BACKGROUND_PATH,
    readFileSync(BACKGROUND_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const labels = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === 'message.type') {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
          labels.add(clause.expression.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...labels].sort()
}

type Listener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
) => unknown

/**
 * Boot the service worker with a chrome stub and hand back its message
 * listener. The module registers listeners as a side effect of the
 * `defineBackground` callback, so this runs it exactly once per test.
 */
/**
 * A chrome stub that completes itself.
 *
 * The service worker touches a wide, growing slice of the extension APIs at
 * boot — webNavigation, alarms, offscreen, action, idle — and hand-listing them
 * turns this file into whack-a-mole that breaks whenever the worker wires up
 * one more. Anything not named explicitly resolves to a callable that also acts
 * as a namespace, so an unanticipated `chrome.x.y.addListener()` is inert
 * instead of a TypeError.
 *
 * The handful with a load-bearing SHAPE — a string URL, an array, an object —
 * are declared, because a Promise where the code expects a string fails in a
 * way that looks like a defect in the code rather than in this stub.
 */
function autoStub(explicit: Record<string, unknown> = {}): unknown {
  const fn = (): Promise<undefined> => Promise.resolve(undefined)
  return new Proxy(fn, {
    get(_t, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (prop in explicit) return explicit[prop]
      return autoStub()
    },
    apply: () => Promise.resolve(undefined),
  })
}

async function bootBackground(): Promise<Listener> {
  const listeners: Listener[] = []
  const noop = vi.fn()

  const chromeStub = autoStub({
    runtime: autoStub({
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => [],
      id: 'test-extension-id',
      lastError: undefined,
    }),
    // Storage answers EMPTY rather than throwing: a locked wallet with no data
    // is a legitimate state, and it is the one a cold service worker boots in.
    storage: autoStub({
      local: autoStub({ get: async () => ({}) }),
      session: autoStub({ get: async () => ({}) }),
      onChanged: { addListener: noop },
    }),
    tabs: autoStub({ query: async () => [] }),
    windows: autoStub({ create: async () => ({ id: 1, tabs: [{ id: 1 }] }) }),
    permissions: autoStub({ contains: async () => true }),
  })

  vi.stubGlobal('chrome', chromeStub)
  vi.stubGlobal('defineBackground', (fn: () => void) => fn)

  // `defineBackground` is stubbed to the identity function above, so the
  // module's default export IS the worker's setup callback. The declared WXT
  // return type does not describe that, hence the double assertion.
  const mod = (await import('@/entrypoints/background')) as unknown as { default: () => void }
  mod.default()

  expect(listeners.length).toBeGreaterThan(0)
  return listeners[0]
}

describe('background.ts dispatch — every case is reachable and answers', () => {
  const TYPES = dispatchedTypes()

  beforeEach(() => {
    vi.resetModules()
  })

  it('the referent is real: the switch has the expected number of cases', () => {
    // Guard the guard. If AST extraction silently returned [], every assertion
    // below would pass vacuously by iterating nothing — the exact shape of
    // vacuous green this repo keeps finding.
    // 38, down from 40: SOC-277 removed LIST_STORED_CREDENTIALS and
    // RESHARE_STORED_VP — the two page-facing vault READS. The floor tracks
    // reality so this stays a real constraint; the intent (a file that
    // dispatches nothing satisfies every other rule) is unchanged.
    expect(TYPES.length).toBeGreaterThanOrEqual(38)
  })

  it.each(dispatchedTypes())('%s is dispatched and answers the caller', async (type) => {
    const listener = await bootBackground()
    const sendResponse = vi.fn()

    // A minimally-shaped message from the extension's own context. Handlers
    // will mostly fail on the empty payload — that is fine and is the point:
    // a FAILED answer is still an answer, and a silent drop is not.
    const returned = listener(
      { type, payload: {} },
      { id: 'test-extension-id', origin: 'chrome-extension://test-extension-id' },
      sendResponse,
    )

    // Either the case replied synchronously, or it kept the channel open by
    // returning true and will reply later. Anything else — undefined return AND
    // no response — leaves the caller hanging until it times out.
    const keptChannelOpen = returned === true
    if (!keptChannelOpen) {
      // Give a synchronously-started promise chain a turn to settle before
      // concluding nobody answered.
      await new Promise((r) => setTimeout(r, 0))
    }

    expect(
      keptChannelOpen || sendResponse.mock.calls.length > 0,
      `case '${type}' neither answered nor returned true — the caller waits forever`,
    ).toBe(true)
  })
})
