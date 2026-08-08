/**
 * Story 1.13 Phase 4 — the approval-window opener, once.
 *
 * Six consent flows (credential offer, auth, credential-wallet auth, document
 * signing, Attestto PDF, payment, CHAPI) each had their own copy of the same
 * twenty lines inside `defineBackground`: stash a pending row, build an
 * `approval.html?…` URL, create a popup window, register a cleanup so a
 * dismissed window doesn't leave the page hanging, and on failure purge the row
 * and report. Six copies is six chances for one to drift — and the cleanup is
 * the security-relevant half: it is what turns "user closed the window" into an
 * explicit denial rather than a silent hang.
 *
 * The URLs this builds are read by `approval.html` via
 * `@/utils/approval-params#resolveApprovalMode`. That shared resolver is the
 * referent the spec asserts against.
 */
import { resolveApprovalMode, type ApprovalMode } from '@/utils/approval-params'

/** Reported to the page when the user dismisses the approval window. */
export const WINDOW_CLOSED_MESSAGE = 'User cancelled — approval window closed'
/** Reported to the page when the approval window could not be created at all. */
export const OPEN_FAILED_MESSAGE = 'Could not open approval window'

/**
 * 5 minutes — generous backstop. The page-side TIMEOUT_MS is 30s, so the page
 * will reject first in nearly all cases. This catches the pathological case
 * where `chrome.windows.onRemoved` never fires (extension crash, page closed
 * before popup, etc.) so pending maps don't leak forever.
 */
export const PENDING_REQUEST_BACKSTOP_MS = 5 * 60 * 1000

/** The browser surface an opener touches. Injected so the spec needs no `chrome`. */
export interface ApprovalWindowPlatform {
  getURL(path: string): string
  createWindow(options: {
    url: string
    type: 'popup'
    width: number
    height: number
    left: number
    top: number
    focused: boolean
  }): Promise<{ id?: number } | undefined>
  /** Geometry of the window the user is looking at, so the popup lands over it. */
  getCurrentWindow(): Promise<{ left?: number; top?: number; width?: number; height?: number }>
  onWindowRemoved(listener: (windowId: number) => void): void
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

/**
 * The slice of a pending-request map an opener needs. Deliberately NOT the whole
 * `Map`: an opener may check, purge, and attach an unregister hook to a row it
 * did not create, but it has no business writing new rows — the caller owns that.
 */
export interface PendingRows {
  has(id: string): boolean
  delete(id: string): boolean
  get(id: string): { unregister?: () => void } | undefined
}

export interface OpenApprovalRequest {
  /** The pending-request id; also what the approval page echoes back on approve/deny. */
  id: string
  /** Query params for `approval.html`. Must carry exactly one mode key (see APPROVAL_MODE_PARAM). */
  params: Record<string, string>
  width: number
  height: number
  /** The map holding this request, so cancel/failure can purge it. */
  rows: PendingRows
  /** Console prefix for the failure log, e.g. `[Attestto Pay]`. */
  logPrefix: string
  /**
   * Report a cancellation to the originating page. Omitted for notification-style
   * flows (a credential offer has no promise waiting on the page side), which is
   * why it is optional rather than a no-op the caller has to remember to pass.
   */
  reportCancelled?: (message: string) => void
}

export interface ApprovalWindows {
  open(request: OpenApprovalRequest): Promise<void>
}

/**
 * Build the approval-window opener. Owns the open-window → cleanup registry, so
 * the entrypoint no longer holds that state.
 */
export function createApprovalWindows(platform: ApprovalWindowPlatform): ApprovalWindows {
  const windowCleanups = new Map<number, () => void>()

  platform.onWindowRemoved((windowId) => {
    const cleanup = windowCleanups.get(windowId)
    if (cleanup) cleanup()
  })

  /**
   * Register `cleanup` to run when the approval window closes, with a timeout
   * backstop. Returns an `unregister` the approve/deny path calls BEFORE sending
   * its response, which makes the cleanup a no-op.
   */
  function registerApprovalWindow(windowId: number | undefined, cleanup: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null

    const unregister = (): void => {
      if (windowId !== undefined) windowCleanups.delete(windowId)
      if (timer) {
        platform.clearTimeout(timer)
        timer = null
      }
    }

    const wrapped = (): void => {
      unregister()
      try {
        cleanup()
      } catch (err) {
        console.error('[Attestto ID] Approval window cleanup failed:', err)
      }
    }

    if (windowId !== undefined) windowCleanups.set(windowId, wrapped)
    timer = platform.setTimeout(wrapped, PENDING_REQUEST_BACKSTOP_MS)
    return unregister
  }

  /**
   * Position the approval popup centred over the focused browser window
   * (Phantom/MetaMask style) instead of Chrome's default (0, 0), which lands it
   * in the corner of the display.
   */
  async function computePosition(width: number, height: number): Promise<{ left: number; top: number }> {
    try {
      const current = await platform.getCurrentWindow()
      const winLeft = current.left ?? 0
      const winTop = current.top ?? 0
      const winWidth = current.width ?? 1280
      const winHeight = current.height ?? 800
      return {
        left: Math.max(0, Math.round(winLeft + (winWidth - width) / 2)),
        top: Math.max(0, Math.round(winTop + (winHeight - height) / 2)),
      }
    } catch {
      return { left: 100, top: 100 }
    }
  }

  async function open(request: OpenApprovalRequest): Promise<void> {
    const { id, params, width, height, rows, logPrefix, reportCancelled } = request
    const url = platform.getURL(`approval.html?${new URLSearchParams(params).toString()}`)

    try {
      const pos = await computePosition(width, height)
      const win = await platform.createWindow({
        url,
        type: 'popup',
        width,
        height,
        left: pos.left,
        top: pos.top,
        focused: true,
      })
      const unregister = registerApprovalWindow(win?.id, () => {
        // Guarded: an approve/deny that already consumed the row must not be
        // re-reported as a cancellation.
        if (!rows.has(id)) return
        rows.delete(id)
        reportCancelled?.(WINDOW_CLOSED_MESSAGE)
      })
      const pending = rows.get(id)
      if (pending) pending.unregister = unregister
    } catch (err) {
      console.error(`${logPrefix} Failed to open approval window:`, err)
      rows.delete(id)
      reportCancelled?.(OPEN_FAILED_MESSAGE)
    }
  }

  return { open }
}

/** The chrome-backed platform. Built once by the composition root. */
export function chromeApprovalWindowPlatform(): ApprovalWindowPlatform {
  return {
    getURL: (path) => chrome.runtime.getURL(path),
    createWindow: (options) => chrome.windows.create(options),
    getCurrentWindow: () => chrome.windows.getCurrent(),
    onWindowRemoved: (listener) => chrome.windows.onRemoved.addListener(listener),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  }
}

/**
 * What `approval.html` will make of the URL these params produce. Exported for
 * the spec, which uses the SHIPPED resolver rather than restating the openers'
 * literals.
 */
export function previewApprovalMode(params: Record<string, string>): ApprovalMode {
  return resolveApprovalMode(new URLSearchParams(params).toString())
}
