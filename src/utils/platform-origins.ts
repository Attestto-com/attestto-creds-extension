/**
 * Platform-origin allowlist.
 *
 * The Attestto platform (PWA / CORTEX) is the one web surface allowed to drive
 * the DID sync flow (`ATTESTTO_DID_SYNC`) without a per-origin user-approval
 * gesture. Every other web origin either has to be user-approved (trust-on-
 * first-use, see `trusted-origins.ts`) or is rejected outright.
 *
 * Trust is keyed off the *sender* origin resolved by `message-guard.ts` — never
 * the page-supplied `payload.origin`, which is attacker-controlled.
 */

import { PLATFORM_URL } from '@/config/app'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Reduce a URL/origin string to its `protocol//host` origin, or null. */
function toOrigin(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** Origins allowed to drive DID_SYNC without per-origin user approval. */
export function platformOrigins(): string[] {
  const origins: string[] = []
  const platform = toOrigin(PLATFORM_URL)
  if (platform) origins.push(platform)
  return origins
}

/**
 * True when `origin` is a trusted platform origin. Localhost/127.0.0.1 on any
 * port is accepted only in dev builds so local platform development works.
 */
export function isPlatformOrigin(origin: string | null | undefined): boolean {
  const key = toOrigin(origin)
  if (!key) return false
  if (platformOrigins().includes(key)) return true

  if (import.meta.env.DEV) {
    try {
      if (LOCAL_HOSTS.has(new URL(key).hostname)) return true
    } catch {
      return false
    }
  }
  return false
}
