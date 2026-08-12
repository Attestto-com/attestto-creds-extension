/**
 * Story 1.13 Phase 11 — the last two inline ctx adapters.
 *
 * `createSigningAdapters` (Phase 1b) took the signing tier's effectful seams out
 * of the entrypoint. These are the other two: the KeyAdmin store + keypair
 * generator, and the untrusted tier's chrome surface. Both were object literals
 * inside `defineBackground`.
 *
 * The KeyAdmin one matters most. Its `generateP256` was a bare
 * `crypto.subtle.generateKey` call sitting in the composition root — the F1
 * capability fence says the entrypoint holds no crypto symbol, and it did. It
 * lives here now, behind the `KeyGen` port, with a test that the exported public
 * JWK carries no private component.
 *
 * These are `Pick<>`s of their bundles, not whole bundles. `UntrustedCtx` also
 * declares `notify` and `http`, and `KeyAdminCtx` declares the abstract `vault` /
 * `crypto` confinement seams — nothing consumes those yet, and satisfying the
 * full type would mean handing KeyAdmin a live signing primitive that no handler
 * calls. Widening a capability to satisfy a type no caller exercises is how sign
 * surfaces grow; the tiers stay partial until a route needs the rest.
 */
import type { UntrustedCtx, KeyAdminCtx } from '@/background/ctx/ctx-bundles'
import type { VaultData } from '@/stores/wallet'

/** The vault utilities the KeyAdmin store wraps. Injected so the adapter is testable. */
export interface KeyAdminVaultUtils {
  readVault(): Promise<VaultData | null>
  writeVault(vault: VaultData): Promise<void>
  syncPublicVault(vault: VaultData): Promise<void>
}

export type KeyAdminAdapters = Pick<KeyAdminCtx, 'store' | 'keygen'>

/**
 * KeyAdmin's concrete surface: the real vault (read / write / public mirror) and
 * P-256 identity-keypair generation.
 *
 * `generateP256` exports both halves — the private JWK is persisted into the
 * encrypted vault by the handler, the public one is returned to the caller.
 * Generating an identity key is deliberately NOT a sign path: this returns key
 * material, it never signs, and the single gated `crypto.sign` (AD-11c) remains
 * the only way to produce a signature.
 */
export function createKeyAdminAdapters(utils: KeyAdminVaultUtils): KeyAdminAdapters {
  return {
    store: {
      read: () => utils.readVault(),
      write: (vault) => utils.writeVault(vault),
      syncPublic: (vault) => utils.syncPublicVault(vault),
    },
    keygen: {
      generateP256: async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ])
        return {
          privateKeyJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
          publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
        }
      },
    },
  }
}

export type UntrustedAdapters = Pick<UntrustedCtx, 'notifications' | 'runtime'>

/**
 * The untrusted tier's chrome surface: raise an OS notification, broadcast to the
 * popup, resolve a packaged asset URL. No vault, no key, no signing — a handler
 * given this bundle cannot name one.
 */
export function createUntrustedAdapters(): UntrustedAdapters {
  return {
    notifications: {
      create: async (id, options) => {
        chrome.notifications.create(id, options as chrome.notifications.NotificationOptions<true>)
      },
    },
    runtime: {
      sendMessage: async (message) => {
        void chrome.runtime.sendMessage(message)
      },
      getURL: (path) => chrome.runtime.getURL(path),
    },
  }
}
