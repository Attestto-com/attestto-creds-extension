/**
 * Per-site identity preference.
 *
 * When a user has multiple linked identities and approves a sign/auth/payment
 * request, we remember which identity they chose for that origin. Next time
 * the same origin asks, the approval popup default-selects that identity.
 *
 * Storage: a single `chrome.storage.local` entry — `{ [origin]: did }`.
 * Lookup is O(1); the map stays tiny (one entry per site the user has used).
 */

import { STORAGE_KEYS } from '@/config/app'
import { normalizeOrigin } from '@/utils/origin'

export type SiteIdentityPrefs = Record<string, string>

async function readMap(): Promise<SiteIdentityPrefs> {
  const local = await chrome.storage.local.get(STORAGE_KEYS.SITE_IDENTITY_PREFS)
  return (local[STORAGE_KEYS.SITE_IDENTITY_PREFS] as SiteIdentityPrefs | undefined) ?? {}
}

async function writeMap(map: SiteIdentityPrefs): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SITE_IDENTITY_PREFS]: map })
}

export async function getPreferredIdentity(
  origin: string | null | undefined,
): Promise<string | null> {
  const key = normalizeOrigin(origin)
  if (!key) return null
  const map = await readMap()
  return map[key] ?? null
}

export async function setPreferredIdentity(
  origin: string | null | undefined,
  did: string,
): Promise<void> {
  const key = normalizeOrigin(origin)
  if (!key) return
  const map = await readMap()
  map[key] = did
  await writeMap(map)
}

export async function clearPreferredIdentity(origin: string): Promise<void> {
  const key = normalizeOrigin(origin)
  if (!key) return
  const map = await readMap()
  delete map[key]
  await writeMap(map)
}

export async function getAllPreferences(): Promise<SiteIdentityPrefs> {
  return readMap()
}
