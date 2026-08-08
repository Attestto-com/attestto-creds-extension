/**
 * Story 1.14 — tell the background that a human is present.
 *
 * The service worker cannot observe the user. It sees messages, and most of
 * those come from web pages; the popup can be open and in use for minutes
 * without generating one. Before this, that asymmetry ran the wrong way — a
 * background tab's credential-API call reset the lock timer while the user
 * reading their own credential list did not.
 *
 * So the extension's own surfaces report their interaction explicitly. Only
 * real input events count: `pointerdown` and `keydown` require a human, whereas
 * `mousemove` fires from scroll momentum and `focus` fires when a window is
 * merely raised — neither is evidence anybody is there.
 *
 * Throttled, because the point is to move a minutes-scale deadline, not to
 * message the worker on every keystroke (each message also wakes a sleeping
 * worker, so an unthrottled reporter would be a battery bug).
 */

/** One report per this window, at most. */
const THROTTLE_MS = 15_000

const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const

export interface ActivityReporterOptions {
  /** Injectable for tests; defaults to the real message + clock. */
  send?: () => void
  now?: () => number
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}

/**
 * Start reporting. Returns a stop function; call it on unmount so a repeatedly
 * opened popup does not stack listeners.
 */
export function startActivityReporter(options: ActivityReporterOptions = {}): () => void {
  const now = options.now ?? (() => Date.now())
  const target = options.target ?? window
  const send =
    options.send ??
    (() => {
      // Fire-and-forget: the worker may be asleep and there is nothing to await.
      // A rejected promise here (no receiver) must not surface as an unhandled
      // rejection in the popup.
      void chrome.runtime.sendMessage({ type: 'WALLET_ACTIVITY' }).catch(() => {})
    })

  let lastSentAt = -Infinity

  const report = (): void => {
    const t = now()
    if (t - lastSentAt < THROTTLE_MS) return
    lastSentAt = t
    send()
  }

  // Opening the surface is itself a gesture — the user clicked the toolbar icon.
  report()

  for (const event of ACTIVITY_EVENTS) target.addEventListener(event, report, { passive: true })

  return () => {
    for (const event of ACTIVITY_EVENTS) target.removeEventListener(event, report)
  }
}
