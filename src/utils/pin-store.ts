/**
 * User TOFU pin store — local, per-device, anti-phishing trust pin.
 *
 * Each pin record uses a dynamic `properties` keypair map so future contributors
 * can stamp new fields (cert fingerprint, OID, user notes, attestation count,
 * vLEI signer, etc.) onto a pin without a schema migration. The store itself
 * is intentionally thin; richer behaviors are tracked elsewhere — see OPEN ITEMS.
 *
 * OPEN ITEMS — partial implementation of ATT-708. Each item below MUST land
 * before ATT-708 can close. Tracked in Jira; do not silently absorb them here.
 *
 *   - Smart cert rotation detection (normal-90day vs ca-change vs key-change)
 *     → ATT-708 §"Smart rotation detection"
 *   - Per-domain history log of past pins (rotation timeline)
 *     → ATT-708 §"Local pin store schema" (history[] field)
 *   - Encrypted-at-rest when vault keys are available
 *     → ATT-708 §"Honest limits"
 *   - LRU cap / per-user pin limit
 *     → ATT-708 §"Honest limits"
 *   - Cross-tab consistency via storage events (partial — onPinStoreChanged exists,
 *     but tab-coordinated UX is owned by ATT-708 §"Acceptance criteria")
 *
 * Storage namespace: chrome.storage.local[STORAGE_KEYS.PIN_STORE].
 * Plain JSON, NOT encrypted (until ATT-708 §"Honest limits" lands).
 * This is intentionally a separate concern from the dual-vault (identity/key
 * material); pins are anti-phishing trust decisions, not secrets.
 */

import { STORAGE_KEYS } from '@/config/app'

/**
 * A single TOFU pin.
 *
 * `properties` is intentionally Record<string, unknown> so new signals can be
 * attached without changing this file. Read the dynamic keys at the panel layer.
 */
export interface PinRecord {
  /** Lowercased host (URL.host — includes port if non-default) */
  domain: string
  /** ISO8601 when the user first pinned this host */
  addedAt: string
  /** Dynamic, extensible keypairs — see header comment for future fields */
  properties: Record<string, unknown>
}

export type PinMap = Record<string, PinRecord>

function normalizeHost(input: string | null | undefined): string | null {
  if (!input) return null
  try {
    const u = input.includes('://') ? new URL(input) : new URL(`https://${input}`)
    return u.host.toLowerCase()
  } catch {
    return null
  }
}

async function readMap(): Promise<PinMap> {
  const local = await chrome.storage.local.get(STORAGE_KEYS.PIN_STORE)
  return (local[STORAGE_KEYS.PIN_STORE] as PinMap | undefined) ?? {}
}

async function writeMap(map: PinMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PIN_STORE]: map })
}

export async function getPin(host: string | null | undefined): Promise<PinRecord | null> {
  const key = normalizeHost(host)
  if (!key) return null
  const map = await readMap()
  return map[key] ?? null
}

export async function isPinned(host: string | null | undefined): Promise<boolean> {
  return (await getPin(host)) !== null
}

/**
 * Pin a site. If already pinned, merges new properties into the existing record
 * (preserves addedAt). Returns the resulting record, or null for an invalid host.
 */
export async function pinSite(
  host: string | null | undefined,
  properties: Record<string, unknown> = {},
): Promise<PinRecord | null> {
  const key = normalizeHost(host)
  if (!key) return null
  const map = await readMap()
  const now = new Date().toISOString()
  const existing = map[key]
  const next: PinRecord = {
    domain: key,
    addedAt: existing?.addedAt ?? now,
    properties: { ...(existing?.properties ?? {}), ...properties },
  }
  map[key] = next
  await writeMap(map)
  return next
}

export async function unpinSite(host: string | null | undefined): Promise<void> {
  const key = normalizeHost(host)
  if (!key) return
  const map = await readMap()
  if (!(key in map)) return
  delete map[key]
  await writeMap(map)
}

export async function listPins(): Promise<PinRecord[]> {
  const map = await readMap()
  return Object.values(map).sort((a, b) => a.domain.localeCompare(b.domain))
}

/** Subscribe to pin store changes — fires across tabs in this profile. */
export function onPinStoreChanged(cb: (map: PinMap) => void): () => void {
  const handler = (
    changes: { [k: string]: chrome.storage.StorageChange },
    area: 'sync' | 'local' | 'managed' | 'session',
  ) => {
    if (area !== 'local') return
    if (!(STORAGE_KEYS.PIN_STORE in changes)) return
    cb((changes[STORAGE_KEYS.PIN_STORE].newValue as PinMap | undefined) ?? {})
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
