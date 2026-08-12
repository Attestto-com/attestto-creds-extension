/**
 * Story 1.14 — the activity reporter.
 *
 * The referent is a real `EventTarget` dispatching real events, not a spy on
 * `addEventListener`: what matters is that a keystroke produces a report, and
 * "we registered a listener" is not the same claim.
 */
import { describe, it, expect } from 'vitest'
import { startActivityReporter } from './useActivityReporter'

function setup() {
  const sent: number[] = []
  let now = 0
  const target = new EventTarget()
  const stop = startActivityReporter({
    send: () => sent.push(now),
    now: () => now,
    target,
  })
  return {
    sent,
    stop,
    target,
    advance: (ms: number) => {
      now += ms
    },
    press: () => target.dispatchEvent(new Event('keydown')),
    click: () => target.dispatchEvent(new Event('pointerdown')),
  }
}

describe('startActivityReporter', () => {
  it('reports on start — opening the popup is itself a gesture', () => {
    const h = setup()
    expect(h.sent).toEqual([0])
    h.stop()
  })

  it('reports a keystroke once the throttle window has passed', () => {
    const h = setup()
    h.advance(20_000)
    h.press()
    expect(h.sent).toEqual([0, 20_000])
    h.stop()
  })

  it('throttles a burst to a single report', () => {
    const h = setup()
    h.advance(20_000)
    // 50 keystrokes spanning 5s — inside one throttle window after the first.
    for (let i = 0; i < 50; i++) {
      h.advance(100)
      h.press()
    }
    expect(h.sent).toEqual([0, 20_100])
    h.stop()
  })

  it('keeps reporting as long as the user keeps working', () => {
    const h = setup()
    h.advance(20_000)
    h.click()
    h.advance(20_000)
    h.click()
    expect(h.sent).toEqual([0, 20_000, 40_000])
    h.stop()
  })

  it('ignores events that do not prove a human is there', () => {
    const h = setup()
    h.advance(60_000)
    h.target.dispatchEvent(new Event('mousemove'))
    h.target.dispatchEvent(new Event('focus'))
    h.target.dispatchEvent(new Event('scroll'))
    expect(h.sent).toEqual([0])
    h.stop()
  })

  it('stops reporting after teardown — a reopened popup must not stack listeners', () => {
    const h = setup()
    h.stop()
    h.advance(60_000)
    h.press()
    expect(h.sent).toEqual([0])
  })
})
