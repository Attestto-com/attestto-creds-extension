/**
 * Story 1.13 Phase 4 — the approval-window opener.
 *
 * The interesting half is not "does it call chrome.windows.create". It is the
 * cleanup: an approval window the user dismisses must turn into an explicit
 * denial delivered to the waiting page, exactly once, and must NOT fire after an
 * approve/deny already consumed the row. A hang and a denial look identical from
 * inside this module, so every assertion below is on the OBSERVED effect — what
 * the pending map holds and what the page was told — never on whether a
 * collaborator was called.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createApprovalWindows,
  chromeApprovalWindowPlatform,
  previewApprovalMode,
  WINDOW_CLOSED_MESSAGE,
  OPEN_FAILED_MESSAGE,
  PENDING_REQUEST_BACKSTOP_MS,
  type ApprovalWindowPlatform,
} from './approval-window'
import { approvalParams } from '@/utils/approval-params'
import { createPendingFlow, type PendingFlow } from './pending-flow'
import { createPendingStore, type PendingStorage } from './pending-store'

interface Row {
  id: string
}

/** Let the cleanup's promise chain settle — claiming a row is async now. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A fake platform: no chrome, no real timers, and window closure is a function call. */
function fakePlatform(overrides: Partial<ApprovalWindowPlatform> = {}) {
  const created: { url: string; width: number; height: number; left: number; top: number }[] = []
  let removedListener: ((windowId: number) => void) | undefined
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 1
  let nextWindowId = 100

  const platform: ApprovalWindowPlatform = {
    getURL: (path) => `chrome-extension://test/${path}`,
    createWindow: async (options) => {
      created.push({ url: options.url, width: options.width, height: options.height, left: options.left, top: options.top })
      return { id: nextWindowId++ }
    },
    getCurrentWindow: async () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    onWindowRemoved: (listener) => {
      removedListener = listener
    },
    setTimeout: ((fn: () => void, ms: number) => {
      const handle = nextTimer++
      timers.set(handle, { fn, ms })
      return handle as unknown as ReturnType<typeof setTimeout>
    }),
    clearTimeout: ((handle: unknown) => {
      timers.delete(handle as number)
    }),
    ...overrides,
  }

  return {
    platform,
    created,
    closeWindow: (windowId: number) => removedListener?.(windowId),
    /** Fire every armed backstop, as if 5 minutes elapsed with the window still open. */
    elapseBackstop: () => [...timers.values()].forEach((t) => t.fn()),
    armedTimers: () => [...timers.values()],
    firstWindowId: 100,
  }
}

function memoryStorage(): PendingStorage {
  let data: Record<string, unknown> = {}
  return {
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (entries) => {
      data = { ...data, ...structuredClone(entries) }
    },
  }
}

/**
 * A REAL pending flow, seeded with the given ids. Story 1.15 made the opener's
 * view of a row `take` + `attachUnregister`; using the real flow here means the
 * atomicity the cleanup now depends on is exercised, not restated.
 *
 * `put` is not awaited: every operation on a flow goes through one queue inside
 * the store, so a later `take` cannot overtake this write.
 */
function rowFlow(...ids: string[]): PendingFlow<Row> & { has(id: string): Promise<boolean> } {
  const flow = createPendingFlow<Row>(
    createPendingStore({ flow: 'test', storage: memoryStorage(), now: () => 1_000_000 }),
  )
  for (const id of ids) void flow.put(id, { id })
  return Object.assign(flow, {
    has: async (id: string) => (await flow.peek(id)) !== null,
  })
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const ID = 'req-1'

describe('the URL handed to approval.html', () => {
  it('is read back by the page resolver as the flow that opened it', async () => {
    const { platform, created } = fakePlatform()
    const windows = createApprovalWindows(platform)
    const params = approvalParams.payment({ id: ID, origin: 'https://shop.cr', amount: 12, merchantName: 'Tienda' })

    await windows.open({ id: ID, params, width: 380, height: 580, rows: rowFlow(ID), logPrefix: '[Pay]' })

    expect(created).toHaveLength(1)
    expect(created[0].url.startsWith('chrome-extension://test/approval.html?')).toBe(true)
    // The referent: the resolver the approval page runs, on the URL just built.
    expect(previewApprovalMode(params)).toMatchObject({ mode: 'payment', requestId: ID, merchant: 'Tienda' })
  })

  it('centres the popup over the focused window at the requested size', async () => {
    const { platform, created } = fakePlatform()
    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.chapi({ id: ID }),
      width: 380,
      height: 520,
      rows: rowFlow(ID),
      logPrefix: '[X]',
    })
    // 1000×800 window, 380×520 popup → centred.
    expect(created[0]).toMatchObject({ width: 380, height: 520, left: 310, top: 140 })
  })

  it('falls back to a fixed corner when the current window cannot be read', async () => {
    const { platform, created } = fakePlatform({
      getCurrentWindow: async () => {
        throw new Error('no window')
      },
    })
    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.chapi({ id: ID }),
      width: 380,
      height: 520,
      rows: rowFlow(ID),
      logPrefix: '[X]',
    })
    expect(created[0]).toMatchObject({ left: 100, top: 100 })
  })
})

describe('dismissing the approval window', () => {
  it('purges the pending row and tells the waiting page it was cancelled', async () => {
    const { platform, closeWindow, firstWindowId } = fakePlatform()
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(m),
    })
    expect(await rows.has(ID)).toBe(true)

    closeWindow(firstWindowId)
    await flush()

    expect(await rows.has(ID)).toBe(false)
    expect(told).toEqual([WINDOW_CLOSED_MESSAGE])
  })

  it('does NOT report a cancellation once approve/deny consumed the row', async () => {
    const { platform, closeWindow, firstWindowId } = fakePlatform()
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(m),
    })

    // The approve path: claim the row, then close the window it opened.
    await rows.take(ID)
    closeWindow(firstWindowId)
    await flush()

    expect(told).toEqual([])
  })

  it('claiming the row IS the disarm — the two cannot be done separately', async () => {
    const { platform, closeWindow, firstWindowId } = fakePlatform()
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(m),
    })

    // There is no way to disarm without claiming, and no way to claim twice.
    // A second claimant — here the closing window — gets nothing to report.
    expect(await rows.take(ID)).not.toBeNull()
    closeWindow(firstWindowId)
    await flush()

    expect(told).toEqual([])
  })

  it('reports exactly once when the window closes twice', async () => {
    const { platform, closeWindow, firstWindowId } = fakePlatform()
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(m),
    })

    closeWindow(firstWindowId)
    closeWindow(firstWindowId)
    await flush()

    expect(told).toEqual([WINDOW_CLOSED_MESSAGE])
  })

  it('stays silent for notification-style flows that have no page promise waiting', async () => {
    const { platform, closeWindow, firstWindowId } = fakePlatform()
    const rows = rowFlow(ID)

    // A credential offer passes no reporter — the page already got `pendingConsent: true`.
    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.credentialOffer({ id: ID, format: 'sd-jwt', issuerName: 'B', origin: null }),
      width: 420,
      height: 560,
      rows,
      logPrefix: '[Offer]',
    })

    expect(() => closeWindow(firstWindowId)).not.toThrow()
    expect(await rows.has(ID)).toBe(false)
  })
})

describe('the backstop', () => {
  it('cleans up a request whose window-closed event never arrives', async () => {
    const { platform, elapseBackstop } = fakePlatform()
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.auth({ id: ID, origin: 'https://x.cr' }),
      width: 380,
      height: 460,
      rows,
      logPrefix: '[Auth]',
      reportCancelled: (m) => told.push(m),
    })

    elapseBackstop()
    await flush()

    expect(await rows.has(ID)).toBe(false)
    expect(told).toEqual([WINDOW_CLOSED_MESSAGE])
  })

  it('is armed at five minutes — longer than the page-side 30s timeout', async () => {
    const { platform, armedTimers } = fakePlatform()
    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.auth({ id: ID, origin: '' }),
      width: 380,
      height: 460,
      rows: rowFlow(ID),
      logPrefix: '[Auth]',
    })
    expect(armedTimers().map((t) => t.ms)).toEqual([PENDING_REQUEST_BACKSTOP_MS])
    expect(PENDING_REQUEST_BACKSTOP_MS).toBeGreaterThan(30_000)
  })

  it('is disarmed by unregister, so an approved request cannot be cancelled later', async () => {
    const { platform, elapseBackstop } = fakePlatform()
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.auth({ id: ID, origin: '' }),
      width: 380,
      height: 460,
      rows,
      logPrefix: '[Auth]',
      reportCancelled: (m) => told.push(m),
    })

    await rows.take(ID)
    elapseBackstop()
    await flush()

    expect(told).toEqual([])
  })
})

describe('when the window cannot be opened at all', () => {
  it('purges the row and tells the page, rather than leaving it hanging', async () => {
    const { platform } = fakePlatform({
      createWindow: async () => {
        throw new Error('no windows available')
      },
    })
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(m),
    })

    expect(await rows.has(ID)).toBe(false)
    expect(told).toEqual([OPEN_FAILED_MESSAGE])
  })

  it('arms no backstop for a window that was never created', async () => {
    const { platform, armedTimers } = fakePlatform({
      createWindow: async () => {
        throw new Error('nope')
      },
    })
    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows: rowFlow(ID),
      logPrefix: '[Sign]',
    })
    expect(armedTimers()).toEqual([])
  })

  it('still cleans up when the browser returns no window id', async () => {
    const { platform, elapseBackstop } = fakePlatform({ createWindow: async () => undefined })
    const rows = rowFlow(ID)
    const told: string[] = []

    await createApprovalWindows(platform).open({
      id: ID,
      params: approvalParams.signing({ id: ID }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(m),
    })

    // No id means no onRemoved correlation; only the backstop can save the page.
    elapseBackstop()
    await flush()
    expect(told).toEqual([WINDOW_CLOSED_MESSAGE])
    expect(await rows.has(ID)).toBe(false)
  })
})

describe('concurrent approvals', () => {
  it('closing one window does not cancel another request', async () => {
    const { platform, closeWindow, firstWindowId } = fakePlatform()
    const rows = rowFlow('a', 'b')
    const told: string[] = []
    const windows = createApprovalWindows(platform)

    await windows.open({
      id: 'a',
      params: approvalParams.signing({ id: 'a' }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Sign]',
      reportCancelled: (m) => told.push(`a:${m}`),
    })
    await windows.open({
      id: 'b',
      params: approvalParams.payment({ id: 'b', amount: 1 }),
      width: 380,
      height: 580,
      rows,
      logPrefix: '[Pay]',
      reportCancelled: (m) => told.push(`b:${m}`),
    })

    closeWindow(firstWindowId)
    await flush()

    expect(told).toEqual([`a:${WINDOW_CLOSED_MESSAGE}`])
    expect(await rows.has('b')).toBe(true)
  })
})

describe('chrome platform adapter', () => {
  it('resolves packaged URLs and forwards window creation to chrome', async () => {
    const create = vi.fn(async () => ({ id: 1 }))
    const addListener = vi.fn()
    ;(globalThis as Record<string, unknown>).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://real/${p}` },
      windows: { create, getCurrent: async () => ({ left: 1 }), onRemoved: { addListener } },
    }

    const platform = chromeApprovalWindowPlatform()
    expect(platform.getURL('approval.html')).toBe('chrome-extension://real/approval.html')
    await platform.createWindow({ url: 'u', type: 'popup', width: 1, height: 2, left: 3, top: 4, focused: true })
    expect(create).toHaveBeenCalledWith({ url: 'u', type: 'popup', width: 1, height: 2, left: 3, top: 4, focused: true })
    expect(await platform.getCurrentWindow()).toEqual({ left: 1 })

    platform.onWindowRemoved(() => {})
    expect(addListener).toHaveBeenCalledTimes(1)
  })
})
