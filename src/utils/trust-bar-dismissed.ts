/**
 * Per-host dismissal memory for the in-page gov trust bar.
 *
 * When the user clicks × on the trust bar for a given host, we remember that
 * host so the bar does not reappear on future visits. Stored as a plain array
 * of normalized hostnames under a single `chrome.storage.local` key.
 *
 * This is intentionally separate from the trusted-origins / pin stores: those
 * carry security meaning; this is a UI-nag preference only.
 */

const STORAGE_KEY = 'attestto_trust_bar_dismissed'

function normalize(host: string | null | undefined): string | null {
  if (!host) return null
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  return h || null
}

async function readList(): Promise<string[]> {
  try {
    const local = await chrome.storage.local.get(STORAGE_KEY)
    const raw = local[STORAGE_KEY]
    return Array.isArray(raw) ? (raw as string[]) : []
  } catch {
    return []
  }
}

/** True if the user previously dismissed the trust bar for this host. */
export async function isTrustBarDismissed(host: string | null | undefined): Promise<boolean> {
  const key = normalize(host)
  if (!key) return false
  const list = await readList()
  return list.includes(key)
}

/** Remember that the user dismissed the trust bar for this host. */
export async function dismissTrustBarForHost(host: string | null | undefined): Promise<void> {
  const key = normalize(host)
  if (!key) return
  try {
    const list = await readList()
    if (list.includes(key)) return
    list.push(key)
    await chrome.storage.local.set({ [STORAGE_KEY]: list })
  } catch {
    // Fail soft — dismissal not persisting is a nuisance, not a break.
  }
}
