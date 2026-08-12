/**
 * Per-origin consent memory.
 *
 * Tracks which web origins the user has explicitly approved for silent
 * identity-offer sync (CREDENTIAL_OFFER with format=attestto-id). First-sight
 * offers from an unknown origin require user consent via the OS notification
 * accept flow; once approved, future offers from the same origin are accepted
 * silently so the UX matches what users expect from a logged-in platform.
 *
 * This closes the gap where any web page could push an `attestto-id` payload
 * and have it land in linkedIdentities[] with no user gesture.
 */

import { STORAGE_KEYS } from '@/config/app'
import { normalizeOrigin } from '@/utils/origin'

export interface TrustedOriginRecord {
  /** ISO timestamp when the user first approved this origin */
  trustedSince: string
  /** ISO timestamp of the most recent silent identity sync */
  lastUsed: string
}

export type TrustedOriginsMap = Record<string, TrustedOriginRecord>

async function readMap(): Promise<TrustedOriginsMap> {
  const local = await chrome.storage.local.get(STORAGE_KEYS.TRUSTED_ORIGINS)
  return (local[STORAGE_KEYS.TRUSTED_ORIGINS] as TrustedOriginsMap | undefined) ?? {}
}

async function writeMap(map: TrustedOriginsMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.TRUSTED_ORIGINS]: map })
}

export async function isOriginTrusted(origin: string | null | undefined): Promise<boolean> {
  const key = normalizeOrigin(origin)
  if (!key) return false
  const map = await readMap()
  return Boolean(map[key])
}

export async function recordTrustedOrigin(origin: string | null | undefined): Promise<void> {
  const key = normalizeOrigin(origin)
  if (!key) return
  const map = await readMap()
  const now = new Date().toISOString()
  const existing = map[key]
  map[key] = {
    trustedSince: existing?.trustedSince ?? now,
    lastUsed: now,
  }
  await writeMap(map)
}

export async function revokeTrustedOrigin(origin: string): Promise<void> {
  const key = normalizeOrigin(origin)
  if (!key) return
  const map = await readMap()
  delete map[key]
  await writeMap(map)
}

export async function getTrustedOrigins(): Promise<TrustedOriginsMap> {
  return readMap()
}
