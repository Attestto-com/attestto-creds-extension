/**
 * User-local blocklist — the negative-trust counterpart to pin-store.
 *
 * When a user reports a site (or chooses "this is a phishing attempt"), the
 * domain is added here. computeStateForUrl reads from this store BEFORE any
 * other signal — user-explicit distrust beats brand-squat detection, pin
 * status, registry membership, everything. Highest-precedence negative.
 *
 * Structure intentionally mirrors pin-store so the two together form a clean
 * "user trust decisions" pair: pinned = green-pinned (user trusts), blocked =
 * red (user distrusts). Both live in chrome.storage.local, plain JSON, not
 * encrypted (same rationale as pin-store: trust decisions, not secrets).
 *
 * The remote/community blocklist (when ATT-630 Trust Registry ships) is a
 * SEPARATE input that feeds the red state independently. This module is
 * strictly user-local.
 */

import { STORAGE_KEYS } from '@/config/app'

export interface BlockRecord {
  /** Lowercased host (URL.host — includes port if non-default) */
  domain: string
  /** ISO8601 when the user blocked this host */
  blockedAt: string
  /** Free-form reason the user gave (e.g., "looked like BCCR"). Optional. */
  reason?: string
  /** Whether the user opted to share this report with Attestto community. */
  sharedWithCommunity: boolean
}

export type BlockMap = Record<string, BlockRecord>

function normalizeHost(input: string | null | undefined): string | null {
  if (!input) return null
  try {
    const u = input.includes('://') ? new URL(input) : new URL(`https://${input}`)
    return u.host.toLowerCase()
  } catch {
    return null
  }
}

async function readMap(): Promise<BlockMap> {
  const local = await chrome.storage.local.get(STORAGE_KEYS.BLOCKLIST_STORE)
  return (local[STORAGE_KEYS.BLOCKLIST_STORE] as BlockMap | undefined) ?? {}
}

async function writeMap(map: BlockMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.BLOCKLIST_STORE]: map })
}

export async function getBlock(host: string | null | undefined): Promise<BlockRecord | null> {
  const key = normalizeHost(host)
  if (!key) return null
  const map = await readMap()
  return map[key] ?? null
}

export async function isBlocked(host: string | null | undefined): Promise<boolean> {
  return (await getBlock(host)) !== null
}

/**
 * Block a site. If already blocked, updates timestamp + reason + sharing flag.
 * Returns the resulting record, or null for an invalid host.
 */
export async function blockSite(
  host: string | null | undefined,
  opts: { reason?: string; sharedWithCommunity?: boolean } = {},
): Promise<BlockRecord | null> {
  const key = normalizeHost(host)
  if (!key) return null
  const map = await readMap()
  const next: BlockRecord = {
    domain: key,
    blockedAt: new Date().toISOString(),
    reason: opts.reason,
    sharedWithCommunity: opts.sharedWithCommunity ?? false,
  }
  map[key] = next
  await writeMap(map)
  return next
}

export async function unblockSite(host: string | null | undefined): Promise<void> {
  const key = normalizeHost(host)
  if (!key) return
  const map = await readMap()
  if (!(key in map)) return
  delete map[key]
  await writeMap(map)
}

export async function listBlocks(): Promise<BlockRecord[]> {
  const map = await readMap()
  return Object.values(map).sort((a, b) => a.domain.localeCompare(b.domain))
}

/** Subscribe to blocklist changes — fires across tabs in this profile. */
export function onBlocklistChanged(cb: (map: BlockMap) => void): () => void {
  const handler = (
    changes: { [k: string]: chrome.storage.StorageChange },
    area: 'sync' | 'local' | 'managed' | 'session',
  ): void => {
    if (area !== 'local') return
    if (!(STORAGE_KEYS.BLOCKLIST_STORE in changes)) return
    cb((changes[STORAGE_KEYS.BLOCKLIST_STORE].newValue as BlockMap | undefined) ?? {})
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
