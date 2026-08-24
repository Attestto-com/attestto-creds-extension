/**
 * Story 1.13 Phase 1a — the composition-root bundle factory (AD-3, AD-11c).
 *
 * `dispatch` needs `buildBundle: <T>(tag) => CtxFor<T>` (dispatch.ts). This module
 * is where that factory LIVES so it is unit-testable in isolation (the entrypoint
 * `defineBackground` is not importable into Vitest) — the composition root is the
 * injection *site* (constructs real adapters, calls this factory), not the injection
 * *code* (Architect, party 2026-08-08). The single `createGatedSign` binding lives
 * here, so the entrypoint holds NO signing symbol (the F1 capability fence).
 *
 * Signing tier (the crown jewel, AD-11c): the request-dependent key (root vs lazy
 * Ed25519 vs per-site) is modelled as a PER-BUNDLE key-slot. Because `dispatch`
 * calls `buildBundle('signing')` per message, each signing bundle is FRESH — its
 * `provisionEd25519`/`provisionSiteDid` set a private slot that the ONE gated
 * `crypto.sign` reads (unset ⇒ root). Fresh-per-message ⇒ no cross-request key
 * bleed; provisioning SETS a key, it is never a sign path — so `rawSign` stays
 * reachable through exactly one field (`crypto.sign`), gated (party F4).
 *
 * The two legacy inline `subtle.sign` sites (es256/Ed25519) become injected
 * `rawSign` primitives here — never a reachable bundle field.
 */
import type { CtxBundleTag, CtxFor } from '@/background/router/route'
import type { UntrustedCtx, SigningCtx, ConsentCtx, KeyAdminCtx } from './ctx-bundles'
import type { Crypto, Clock, SigningVaultStore, VaultRead, SitePin, Provisioning } from '@/background/ports/ports'
import { createGatedSign, type PresenceGate, type RawSign } from '@/background/crypto/gated-sign'

/**
 * The signing-tier adapters the composition root injects. `rootRawSign` and the two
 * `provision*` rawSigns are the ONLY signing primitives — each is a gate-free raw
 * signer that the factory wraps in the single `createGatedSign`. A `provision*`
 * returns PUBLIC material (AD-2) plus the raw signer to bind into the key-slot.
 */
export interface SigningAdapters {
  store: SigningVaultStore
  vault: VaultRead
  clock: Clock
  pin: SitePin
  assertPresence: PresenceGate
  /** Signs with the root identity key (reads the vault internally). */
  rootRawSign: RawSign
  /** Lazily provision the Ed25519 key; returns its public key + the raw signer to bind. */
  provisionEd25519: () => Promise<{ publicKeyB64: string; rawSign: RawSign } | null>
  /** Find-or-create the per-origin DID; returns public material + the raw signer to bind. */
  provisionSiteDid: (
    origin: string,
  ) => Promise<{ did: string; publicKeyJwk: JsonWebKey; rawSign: RawSign } | null>
}

/** Everything the composition root injects to build the four capability bundles. */
export interface BundleAdapters {
  untrusted: UntrustedCtx
  consent: ConsentCtx
  keyAdmin: KeyAdminCtx
  signing: SigningAdapters
}

/**
 * Build a FRESH signing bundle with a per-bundle key-slot. The slot defaults to the
 * root signer; provisioning rebinds it. The ONE gated `sign` reads the slot at call
 * time — so a request that provisions an Ed25519/site key signs with it, gated, and
 * a request that does not signs with root, gated. No ungated alternative exists.
 */
function buildSigning(a: SigningAdapters): SigningCtx {
  let activeRawSign: RawSign = a.rootRawSign

  const provisioning: Provisioning = {
    async provisionEd25519() {
      const r = await a.provisionEd25519()
      if (!r) return null
      activeRawSign = r.rawSign
      return { publicKeyB64: r.publicKeyB64 }
    },
    async provisionSiteDid(origin: string) {
      const r = await a.provisionSiteDid(origin)
      if (!r) return null
      activeRawSign = r.rawSign
      return { did: r.did, publicKeyJwk: r.publicKeyJwk }
    },
  }

  // The SINGLE gated primitive (AD-11c). It reads the key-slot lazily, so the
  // request-dependent key never widens the sign surface.
  const crypto: Crypto = {
    sign: createGatedSign({ assertPresence: a.assertPresence, rawSign: (p) => activeRawSign(p) }),
  }

  return { crypto, vault: a.vault, store: a.store, clock: a.clock, provisioning, pin: a.pin }
}

/**
 * The `buildBundle` the router consumes. Per-tag; `signing` mints a fresh bundle
 * (key-slot) each call. The return type ties to the single `CtxByTag` map (route.ts),
 * so a factory that returns the wrong bundle for a tag fails to type-check.
 */
export function createBuildBundle(
  a: BundleAdapters,
): <T extends CtxBundleTag>(tag: T) => CtxFor<T> {
  return <T extends CtxBundleTag>(tag: T): CtxFor<T> => {
    switch (tag) {
      case 'untrusted':
        return a.untrusted as CtxFor<T>
      case 'signing':
        return buildSigning(a.signing) as CtxFor<T>
      case 'consent':
        return a.consent as CtxFor<T>
      case 'keyAdmin':
        return a.keyAdmin as CtxFor<T>
      default: {
        const _exhaustive: never = tag
        throw new Error(`buildBundle: unknown tag ${String(_exhaustive)}`)
      }
    }
  }
}
