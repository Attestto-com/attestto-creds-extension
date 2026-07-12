import type { PublicVaultData } from '@/utils/vault'

/**
 * True when a public vault mirror holds at least one identity the user could
 * sign in with.
 *
 * Pure predicate over the unencrypted public mirror, so it can run in the
 * service worker without a passkey unlock and be unit-tested in isolation. Kept
 * in sync with how the popup chooses between the empty "Get Started" state and
 * the identity list: any of a root `did`, a `holderDid`, or at least one
 * `linkedIdentities` entry counts as set up.
 */
export function hasIdentity(pub: PublicVaultData | null | undefined): boolean {
  if (!pub) return false
  return Boolean(pub.did || pub.holderDid || (pub.linkedIdentities?.length ?? 0) > 0)
}
