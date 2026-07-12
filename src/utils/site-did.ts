/**
 * Per-site (pairwise) DID — find-or-create.
 *
 * Login uses a UNIQUE DID per origin so that sites cannot correlate a user
 * across the web. The keypair is generated locally (`did:jwk`, P-256) and
 * stored in the encrypted vault under `siteDids[origin]`; the public mirror
 * carries only `origin → did` so the approval popup can tell a new site from a
 * returning one without an unlock.
 *
 * Identity attributes never travel on this channel. A site that wants to know
 * something about the user must request a Verifiable Credential, which the user
 * presents explicitly (the VP / consent flow) — never the login handle.
 */

import { publicJwkToDid } from '@/utils/did-jwk'

/** A pairwise DID owned by the wallet, scoped to a single origin. */
export interface SiteDidEntry {
  /** The self-resolving `did:jwk` for this site. */
  did: string
  /** The P-256 private key that signs on behalf of this site DID. */
  privateKeyJwk: JsonWebKey
  /** ISO timestamp the pairwise DID was minted. */
  createdAt: string
  /** ISO timestamp of the most recent sign-in to this site. */
  lastUsedAt: string
}

/**
 * Normalize an origin to `protocol//host`, so `https://x.com/a` and
 * `https://x.com/b` share one pairwise DID. Returns null for unusable input.
 */
export function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null
  try {
    const u = new URL(origin)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** Generate a fresh pairwise `did:jwk` keypair for a site. */
export async function generateSiteDid(): Promise<SiteDidEntry> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  const now = new Date().toISOString()
  return {
    did: publicJwkToDid(publicJwk),
    privateKeyJwk: privateJwk,
    createdAt: now,
    lastUsedAt: now,
  }
}

/**
 * Find-or-create the pairwise DID for an origin within a vault's `siteDids` map.
 * Returns the (possibly newly-created) map, the entry, and whether it was just
 * minted. The caller persists the vault (encrypted + public mirror) when
 * `created` is true.
 */
export async function findOrCreateSiteDid(
  siteDids: Record<string, SiteDidEntry> | undefined,
  origin: string | null | undefined,
): Promise<{ siteDids: Record<string, SiteDidEntry>; entry: SiteDidEntry; created: boolean; key: string }> {
  const key = normalizeOrigin(origin)
  if (!key) throw new Error('Invalid origin for site DID')

  const map = siteDids ?? {}
  const existing = map[key]
  if (existing) return { siteDids: map, entry: existing, created: false, key }

  const entry = await generateSiteDid()
  map[key] = entry
  return { siteDids: map, entry, created: true, key }
}

/** Public-key half of a site DID entry, for the AUTH response `publicKeyJwk`. */
export function publicJwkOf(entry: SiteDidEntry): { kty: string; crv: string; x: string; y: string } {
  const jwk = entry.privateKeyJwk as Record<string, string>
  return { kty: jwk.kty || 'EC', crv: jwk.crv || 'P-256', x: jwk.x, y: jwk.y }
}
