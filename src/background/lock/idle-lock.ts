/**
 * Story 1.14 — idle auto-lock measured from the last USER action.
 *
 * What was here before, and why it did not lock when it mattered:
 *
 *   chrome.alarms.create('autoLock', { delayInMinutes: 1 })   // at SW top level
 *   onAlarm('autoLock') → storage.session.remove(SESSION_KEY)
 *
 * The deadline was a side effect of the service-worker lifecycle. MV3 kills the
 * worker on idle and revives it for any message, so the timer restarted every
 * time *anything* woke the background — including a `CREDENTIAL_OFFER` from a
 * background tab the user was not looking at. A web page could therefore hold
 * the vault open indefinitely, while the user's own popup activity, which does
 * not necessarily message the worker, reset nothing. The control was pointed the
 * wrong way round.
 *
 * The fix is to stop treating "the alarm fired" as "time to lock". The deadline
 * lives in `chrome.storage.session` as a timestamp of the last user gesture, and
 * every decision is recomputed from it:
 *
 *   - `touch()`    a user did something → stamp now, re-arm for now + timeout
 *   - `resume()`   the worker restarted → do NOT stamp; re-arm for the deadline
 *                  that was already running, or lock if it has passed
 *   - `onAlarm()`  the alarm fired → lock only if the stamp says the idle window
 *                  really elapsed; otherwise re-arm for the remainder
 *
 * Storing the stamp in `storage.session` is what makes a worker restart harmless:
 * session storage outlives the worker and dies with the browser, which is the
 * exact lifetime of the session key it guards.
 *
 * Fail-closed rule: an unlocked vault with NO activity stamp is an anomaly (the
 * stamp and the session key are written to the same storage area and are meant
 * to appear and vanish together). We lock rather than invent a fresh deadline —
 * inventing one is how "auto-lock" quietly becomes "auto-extend".
 */
import type { Clock, Alarms } from '@/background/ports/ports'

/** The alarm name. Exported so the entrypoint's listener and this module agree. */
export const AUTO_LOCK_ALARM = 'autoLock'

/** The last-user-gesture stamp. Same storage area as the session key it guards. */
export const LAST_ACTIVITY_KEY = 'attestto_ext_last_activity'

/**
 * The unlocked-session seam. `isUnlocked` exists so `resume()` can tell "the
 * vault is open and its deadline is running" from "there is nothing to lock" —
 * without it, every worker restart of a locked wallet would arm a pointless alarm.
 */
export interface SessionLock {
  isUnlocked(): Promise<boolean>
  lock(): Promise<void>
}

/** The activity stamp, read/written as epoch milliseconds. */
export interface ActivityStamp {
  read(): Promise<number | null>
  write(atMs: number): Promise<void>
  clear(): Promise<void>
}

export interface IdleLockDeps {
  clock: Clock
  alarms: Alarms
  session: SessionLock
  activity: ActivityStamp
  /** Read fresh each time: the user can change the timeout while the wallet is open. */
  timeoutMs(): Promise<number>
}

export interface IdleLock {
  /** A user did something. Stamp it and re-arm. */
  touch(): Promise<void>
  /**
   * The service worker started (or the timeout setting changed). Re-arm against
   * the deadline that is ALREADY running — never extend it.
   */
  resume(): Promise<void>
  /**
   * An alarm fired. Returns true if it was ours (so the caller knows whether it
   * handled the alarm), regardless of whether it resulted in a lock.
   */
  onAlarm(alarmName: string): Promise<boolean>
}

export function createIdleLock(deps: IdleLockDeps): IdleLock {
  const { clock, alarms, session, activity } = deps

  async function lockNow(): Promise<void> {
    await session.lock()
    await activity.clear()
  }

  /**
   * Decide from the stamp, not from the reason we were called. Every entry point
   * funnels through here, so there is exactly one place that can conclude "lock".
   */
  async function enforce(): Promise<void> {
    if (!(await session.isUnlocked())) return

    const last = await activity.read()
    // Unlocked with no provenance — see the fail-closed rule above.
    if (last === null) {
      await lockNow()
      return
    }

    const deadline = last + (await deps.timeoutMs())
    if (clock.now() >= deadline) {
      await lockNow()
      return
    }

    await alarms.schedule(AUTO_LOCK_ALARM, deadline)
  }

  return {
    async touch() {
      await activity.write(clock.now())
      await enforce()
    },

    resume: enforce,

    async onAlarm(alarmName) {
      if (alarmName !== AUTO_LOCK_ALARM) return false
      await enforce()
      return true
    },
  }
}

/**
 * The concrete `chrome.storage.session` implementations.
 *
 * `isUnlocked` is a presence check on the session key, not a read of it: this
 * module has no business holding the vault key, and a presence check is all the
 * lock decision needs.
 */
export function chromeSessionLock(sessionKeyName: string): SessionLock {
  return {
    isUnlocked: async () => {
      const got = await chrome.storage.session.get(sessionKeyName)
      return got[sessionKeyName] !== undefined
    },
    lock: async () => {
      await chrome.storage.session.remove(sessionKeyName)
    },
  }
}

export function chromeActivityStamp(): ActivityStamp {
  return {
    read: async () => {
      const got = await chrome.storage.session.get(LAST_ACTIVITY_KEY)
      const value = got[LAST_ACTIVITY_KEY]
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    },
    write: async (atMs) => {
      await chrome.storage.session.set({ [LAST_ACTIVITY_KEY]: atMs })
    },
    clear: async () => {
      await chrome.storage.session.remove(LAST_ACTIVITY_KEY)
    },
  }
}

/** `chrome.alarms` behind the `Alarms` port — absolute `when`, never a delay. */
export function chromeAlarms(): Alarms {
  return {
    schedule: async (name, whenMs) => {
      chrome.alarms.create(name, { when: whenMs })
    },
  }
}
