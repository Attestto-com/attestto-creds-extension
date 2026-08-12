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

/**
 * Idle auto-lock timeout, in minutes (Story 1.14, FR3).
 *
 * There is deliberately **no "never"**. The idle lock is the only thing standing
 * between a walked-away machine and the unlocked vault; an off switch in the
 * settings page would let a single click disable it permanently, and a control a
 * user can turn off is not a control. The longest offer is 30 minutes.
 */
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30] as const
export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number]

/**
 * The secure default. Five minutes is short enough that an unattended machine
 * locks before anyone sits down at it, and long enough that a user reading a
 * document between two signatures is not re-prompted mid-task.
 *
 * The previous value was a hard-coded 1 minute that was measured from the last
 * *service-worker start*, not the last user action — so a background web page
 * calling the credential API pushed it out while the user's own popup activity
 * did not. Measured from real activity, 1 minute is unusable; it remains
 * available as the strictest choice.
 */
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 5

/** Narrow an untrusted stored value to a choice we offer, else the default. */
export function coerceAutoLockMinutes(value: unknown): AutoLockMinutes {
  return (AUTO_LOCK_CHOICES as readonly number[]).includes(value as number)
    ? (value as AutoLockMinutes)
    : DEFAULT_AUTO_LOCK_MINUTES
}

export interface SettingsConfig {
  pinBehavior: PinBehavior
  /** Minutes of user inactivity before the vault re-locks itself. */
  autoLockMinutes: AutoLockMinutes
  /** OS-level notification when a site is flagged as dangerous (RED state). */
  notifyOnRed: boolean
  /** OS-level notification when a pinned site's cert rotates suspiciously. */
  notifyOnRotation: boolean
  /**
   * Inject the in-page trust bar on Costa Rican government sites (`.go.cr`,
   * `.fi.cr`, etc.) when the host is in our TLS snapshot. Opt-out only; the
   * bar never appears on non-gov sites regardless of this flag.
   */
  trustBarEnabled: boolean
}

export const DEFAULT_SETTINGS: SettingsConfig = {
  pinBehavior: 'ask',
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  notifyOnRed: true,
  notifyOnRotation: true,
  trustBarEnabled: true,
}

const STORAGE_KEY = 'attestto_settings'

export async function readSettings(): Promise<SettingsConfig> {
  const result = await chrome.storage.sync.get(STORAGE_KEY)
  return normalize(result[STORAGE_KEY])
}

/**
 * `chrome.storage.sync` is shared across devices and across versions of this
 * extension, so a stored value is untrusted input: an older build, a hand-edited
 * profile, or a half-written sync can leave `autoLockMinutes` as `0`, `null` or
 * `525600`. Spreading that over the defaults would silently disable the lock,
 * which is exactly the fail-open this story exists to remove — so the timeout is
 * narrowed to a value we actually offer on every read.
 */
function normalize(stored: unknown): SettingsConfig {
  const merged = { ...DEFAULT_SETTINGS, ...((stored as Partial<SettingsConfig>) ?? {}) }
  return { ...merged, autoLockMinutes: coerceAutoLockMinutes(merged.autoLockMinutes) }
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
    cb(normalize(changes[STORAGE_KEY].newValue))
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
