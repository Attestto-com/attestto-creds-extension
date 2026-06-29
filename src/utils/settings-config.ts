/**
 * Extension settings — persisted in chrome.storage.sync so settings follow
 * the user across devices. Replaces the deleted `bar-config.ts` after the
 * on-page bar was removed (ATT-726 — bar is inherently spoofable; popup +
 * toolbar + notifications are the only trustable surfaces).
 *
 * Only fields a user can actually choose live here. Things like "RED state
 * notification template" or "icon color per state" are extension-internal
 * constants, not user settings.
 */

/**
 * What the popup does when the user clicks "Trust this site".
 *   - 'ask'   — confirm before pinning (default; protects against fat-finger)
 *   - 'auto'  — pin immediately (power user)
 *   - 'never' — hide the pin action entirely (maximum caution)
 */
export type PinBehavior = 'ask' | 'auto' | 'never'

export interface SettingsConfig {
  pinBehavior: PinBehavior
  /** OS-level notification when a site is flagged as dangerous (RED state). */
  notifyOnRed: boolean
  /** OS-level notification when a pinned site's cert rotates suspiciously. */
  notifyOnRotation: boolean
}

export const DEFAULT_SETTINGS: SettingsConfig = {
  pinBehavior: 'ask',
  notifyOnRed: true,
  notifyOnRotation: true,
}

const STORAGE_KEY = 'attestto_settings'

export async function readSettings(): Promise<SettingsConfig> {
  const result = await chrome.storage.sync.get(STORAGE_KEY)
  return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] ?? {}) }
}

export async function writeSettings(patch: Partial<SettingsConfig>): Promise<SettingsConfig> {
  const current = await readSettings()
  const next = { ...current, ...patch }
  await chrome.storage.sync.set({ [STORAGE_KEY]: next })
  return next
}

export function onSettingsChanged(cb: (cfg: SettingsConfig) => void): () => void {
  const handler = (
    changes: { [k: string]: chrome.storage.StorageChange },
    area: 'sync' | 'local' | 'managed' | 'session',
  ) => {
    if (area !== 'sync') return
    if (!(STORAGE_KEY in changes)) return
    cb({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue ?? {}) })
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
