/**
 * Story 1.14 — the idle lock.
 *
 * The referent is a fake `chrome.storage.session`, not a spy on `lock()`. The
 * question this suite has to answer is "is the vault key still readable?", and a
 * `toHaveBeenCalled` on a collaborator answers a different, easier one — the
 * implementation could call `lock()` on a store that never removes anything and
 * every such assertion would still pass.
 *
 * Time is a plain number the test advances by hand. No fake timers: the whole
 * point of the rewrite is that the deadline is DERIVED from a stored stamp
 * rather than carried by a running timer, and a test that simulates elapsed time
 * with a timer would be asserting the design it replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createIdleLock,
  chromeSessionLock,
  chromeActivityStamp,
  chromeAlarms,
  AUTO_LOCK_ALARM,
  LAST_ACTIVITY_KEY,
  type IdleLock,
} from './idle-lock'
import { STORAGE_KEYS } from '@/config/app'

const MINUTE = 60_000
const TIMEOUT = 5 * MINUTE

/** The real storage area, faked at the chrome API boundary. */
function fakeSessionStorage() {
  let data: Record<string, unknown> = {}
  return {
    get data() {
      return data
    },
    seed(next: Record<string, unknown>) {
      data = { ...next }
    },
    api: {
      get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
      set: async (entries: Record<string, unknown>) => {
        data = { ...data, ...entries }
      },
      remove: async (key: string) => {
        const { [key]: _dropped, ...rest } = data
        data = rest
      },
    },
  }
}

interface Harness {
  lock: IdleLock
  storage: ReturnType<typeof fakeSessionStorage>
  scheduled: { name: string; whenMs: number }[]
  advance(ms: number): void
  isUnlocked(): boolean
  timeout: { value: number }
}

function harness(opts: { unlocked?: boolean; stampedAt?: number | null } = {}): Harness {
  let now = 1_000_000
  const storage = fakeSessionStorage()
  const scheduled: { name: string; whenMs: number }[] = []

  storage.seed({
    ...(opts.unlocked === false ? {} : { [STORAGE_KEYS.SESSION_KEY]: 'base64-session-key' }),
    ...(opts.stampedAt === null || opts.stampedAt === undefined
      ? {}
      : { [LAST_ACTIVITY_KEY]: opts.stampedAt }),
  })

  // Wire the REAL chrome-backed adapters over the fake storage, so the key names
  // and the presence semantics are exercised, not re-declared by the test.
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { session: storage.api },
    alarms: {
      create: (name: string, info: { when: number }) => scheduled.push({ name, whenMs: info.when }),
    },
  }

  const timeout = { value: TIMEOUT }
  const lock = createIdleLock({
    clock: { now: () => now },
    alarms: chromeAlarms(),
    session: chromeSessionLock(STORAGE_KEYS.SESSION_KEY),
    activity: chromeActivityStamp(),
    timeoutMs: async () => timeout.value,
  })

  return {
    lock,
    storage,
    scheduled,
    timeout,
    advance: (ms) => {
      now += ms
    },
    isUnlocked: () => storage.data[STORAGE_KEYS.SESSION_KEY] !== undefined,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('the lock fires on idle', () => {
  it('locks once the idle window elapses — THE story', async () => {
    const h = harness()
    await h.lock.touch()
    expect(h.isUnlocked()).toBe(true)

    h.advance(TIMEOUT)
    await h.lock.onAlarm(AUTO_LOCK_ALARM)

    expect(h.isUnlocked()).toBe(false)
    expect(h.storage.data[LAST_ACTIVITY_KEY]).toBeUndefined()
  })

  it('does NOT lock before the window elapses — it re-arms for the remainder', async () => {
    const h = harness()
    await h.lock.touch()
    const armedAt = h.scheduled.at(-1)!.whenMs

    // An alarm that fires early (Chrome coalesces alarms; it is not a promise).
    h.advance(TIMEOUT - MINUTE)
    await h.lock.onAlarm(AUTO_LOCK_ALARM)

    expect(h.isUnlocked()).toBe(true)
    // Re-armed for the SAME deadline, not pushed a fresh timeout into the future.
    expect(h.scheduled.at(-1)!.whenMs).toBe(armedAt)
  })

  it('ignores an alarm that is not ours', async () => {
    const h = harness()
    await h.lock.touch()
    h.advance(TIMEOUT * 10)

    expect(await h.lock.onAlarm('keepOffscreenAlive')).toBe(false)
    expect(h.isUnlocked()).toBe(true)
  })
})

describe('the deadline is measured from user activity, not from the worker', () => {
  it('a worker restart does not extend a deadline that already passed', async () => {
    // The exact defect: `resume()` stands in for the SW top level re-running.
    const h = harness({ stampedAt: 1_000_000 })
    h.advance(TIMEOUT + 1)

    await h.lock.resume()

    expect(h.isUnlocked()).toBe(false)
  })

  it('a worker restart mid-window re-arms the ORIGINAL deadline', async () => {
    const h = harness({ stampedAt: 1_000_000 })
    h.advance(MINUTE)

    await h.lock.resume()

    expect(h.isUnlocked()).toBe(true)
    expect(h.scheduled).toEqual([{ name: AUTO_LOCK_ALARM, whenMs: 1_000_000 + TIMEOUT }])
  })

  it('repeated restarts cannot walk the deadline forward', async () => {
    // The old code called `chrome.alarms.create('autoLock', {delayInMinutes: 1})`
    // at the top level, so N wakes bought N more minutes. Here, N wakes buy none.
    const h = harness({ stampedAt: 1_000_000 })
    for (let i = 0; i < 20; i++) {
      h.advance(MINUTE / 4)
      await h.lock.resume()
    }
    expect(h.scheduled.every((s) => s.whenMs === 1_000_000 + TIMEOUT)).toBe(true)

    h.advance(TIMEOUT)
    await h.lock.resume()
    expect(h.isUnlocked()).toBe(false)
  })

  it('touch() DOES move the deadline — activity is the one thing that may', async () => {
    const h = harness({ stampedAt: 1_000_000 })
    h.advance(MINUTE)
    await h.lock.touch()

    expect(h.storage.data[LAST_ACTIVITY_KEY]).toBe(1_000_000 + MINUTE)
    expect(h.scheduled.at(-1)!.whenMs).toBe(1_000_000 + MINUTE + TIMEOUT)
  })

  it('a locked wallet arms nothing on restart', async () => {
    const h = harness({ unlocked: false, stampedAt: 1_000_000 })
    await h.lock.resume()
    expect(h.scheduled).toEqual([])
  })
})

describe('fail-closed', () => {
  it('locks an unlocked vault that has NO activity stamp', async () => {
    // Session key without provenance: a build that unlocked without stamping, or
    // a partially-cleared session. Inventing a deadline here would turn the
    // control into auto-extend, so the answer is to lock.
    const h = harness({ stampedAt: null })
    await h.lock.resume()
    expect(h.isUnlocked()).toBe(false)
  })

  it('treats a corrupt stamp as no stamp', async () => {
    const h = harness()
    h.storage.seed({ [STORAGE_KEYS.SESSION_KEY]: 'k', [LAST_ACTIVITY_KEY]: 'not-a-number' })
    await h.lock.resume()
    expect(h.isUnlocked()).toBe(false)
  })

  it('shortening the timeout in settings can lock immediately', async () => {
    const h = harness({ stampedAt: 1_000_000 })
    h.advance(2 * MINUTE)
    await h.lock.resume()
    expect(h.isUnlocked()).toBe(true)

    h.timeout.value = MINUTE // user picks the strictest option
    await h.lock.resume()
    expect(h.isUnlocked()).toBe(false)
  })

  it('reads the timeout fresh on every decision, never caches it at construction', async () => {
    const h = harness({ stampedAt: 1_000_000 })
    h.timeout.value = 30 * MINUTE
    h.advance(10 * MINUTE)
    await h.lock.resume()
    expect(h.isUnlocked()).toBe(true)
    expect(h.scheduled.at(-1)!.whenMs).toBe(1_000_000 + 30 * MINUTE)
  })
})

describe('the session key is the only thing the lock touches', () => {
  it('leaves unrelated session entries alone', async () => {
    const h = harness()
    h.storage.seed({
      [STORAGE_KEYS.SESSION_KEY]: 'k',
      [LAST_ACTIVITY_KEY]: 1_000_000,
      'attestto_ext_pending_auth': { id: 'auth-1' },
    })
    h.advance(TIMEOUT)
    await h.lock.onAlarm(AUTO_LOCK_ALARM)

    expect(h.isUnlocked()).toBe(false)
    expect(h.storage.data['attestto_ext_pending_auth']).toEqual({ id: 'auth-1' })
  })

  it('does not copy the key anywhere while deciding', async () => {
    // `isUnlocked` has to read the entry to test presence. What must not happen
    // is the value coming back out — into the stamp, into a cache entry, into a
    // second key. Sentinel + scan of the whole serialized area, so a leak by
    // nesting is caught too.
    const secret = 'THE-VAULT-KEY-MATERIAL'
    const h = harness()
    h.storage.seed({ [STORAGE_KEYS.SESSION_KEY]: secret, [LAST_ACTIVITY_KEY]: 1_000_000 })

    h.advance(MINUTE)
    await h.lock.touch()
    await h.lock.resume()

    const { [STORAGE_KEYS.SESSION_KEY]: _theKeyItself, ...everythingElse } = h.storage.data
    expect(JSON.stringify(everythingElse)).not.toContain(secret)
  })

  it('exposes presence as a boolean, not the key', async () => {
    harness()
    const session = chromeSessionLock(STORAGE_KEYS.SESSION_KEY)
    expect(await session.isUnlocked()).toBe(true)
  })
})
