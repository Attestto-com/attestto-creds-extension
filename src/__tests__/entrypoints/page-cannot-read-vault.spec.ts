/**
 * SOC-277 — a page cannot read the vault. Not "unless trusted": at all.
 *
 * ── What this replaces, and why ────────────────────────────────────────────
 *
 * `LIST_STORED_CREDENTIALS` and `RESHARE_STORED_VP` let a page ask the
 * extension "what do you hold?" and then "give me these fields", and the
 * background answered without consulting the user. The first fix here gated
 * them on a trusted origin, and the spec that came with it asserted a trusted
 * origin DID receive credentials — a positive control for the wrong invariant.
 *
 * Eduardo, 2026-08-14, on reading that: a page is untrusted by default and the
 * only thing it may do is PRESENT ITSELF. It cannot ask for the list. It cannot
 * ask for a credential. An origin with no DID does not communicate with the
 * extension at all; an origin with a DID from us or from a whitelisted trusted
 * issuer may ASK — and the ask goes to the USER, who must accept every time.
 * There is no setting that passes data to a site automatically, and there
 * should not be one.
 *
 * Both message types were therefore REMOVED rather than fenced — from the page
 * bridge, the router, the type union and the handler — the same resolution
 * KEY_BACKUP got in SOC-144. Nothing in this codebase consumed the responses,
 * so this deleted attack surface rather than capability.
 *
 * ── Why the assertions are all negative ───────────────────────────────────
 *
 * A test that grants a page vault access encodes the design this product does
 * not have. There is no positive control here on purpose: "the page gets
 * nothing" has no counterpart worth asserting, and inventing one would be the
 * first step back toward a read path.
 *
 * These are source assertions. The runtime referent would be a message that no
 * longer exists, which cannot be sent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MESSAGE_TYPES } from '@/background/router/message-types'

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')

/** The two page-facing names, and the two router names they mapped to. */
const PAGE_TYPES = ['ATTESTTO_LIST_CREDENTIALS', 'ATTESTTO_RESHARE_VP']
const ROUTER_TYPES = ['LIST_STORED_CREDENTIALS', 'RESHARE_STORED_VP']

describe('SOC-277 — the vault is not readable from a page', () => {
  it('the content-script bridge forwards neither request', () => {
    const bridge = read('src/entrypoints/credential-api.content.ts')
    for (const t of PAGE_TYPES) {
      // The names survive only inside the comment recording the removal, so
      // assert on the FORWARD, which is what would make them reachable again.
      expect(bridge, `${t} is forwarded again`).not.toMatch(
        new RegExp(`msgType === '${t}'`),
      )
    }
  })

  it('the router dispatches neither message', () => {
    const background = read('src/entrypoints/background.ts')
    for (const t of ROUTER_TYPES) {
      expect(background, `${t} has a case again`).not.toMatch(new RegExp(`case '${t}'`))
    }
  })

  it('neither type exists in the dispatched-type union', () => {
    // The union is the registry's domain: re-adding a member without a route is
    // a compile error, so this also pins that no route can come back quietly.
    for (const t of ROUTER_TYPES) {
      expect([...MESSAGE_TYPES]).not.toContain(t)
    }
  })

  it('the projection handler is gone, not merely unreferenced', () => {
    // It was a careful, well-tested projection — of data a page should never
    // receive. Leaving it importable is how a read path gets rebuilt by someone
    // who finds a "disclosure boundary" already written for them.
    let found = true
    try {
      readFileSync(
        resolve(process.cwd(), 'src/background/handlers/stored-credential-reads.handler.ts'),
      )
    } catch {
      found = false
    }
    expect(found, 'stored-credential-reads.handler.ts is back').toBe(false)
  })
})
