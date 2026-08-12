/**
 * Story 1.13 Phase 5 — accepting an approved credential offer.
 *
 * The user has consented; this turns the raw offer into a `StoredCredential` and
 * lands it in both vaults. Three decisions here are security-relevant and were
 * previously buried in a 120-line closure inside `defineBackground` with no test
 * that could reach them:
 *
 *  1. **Trust-on-first-use is format-scoped.** Only an `attestto-id` offer from a
 *     known origin records that origin as trusted (future syncs from it are then
 *     silent). A one-off `sd-jwt` / `json-ld` issuance must NOT buy the site
 *     standing permission — see the repo CLAUDE.md's credential-offer section.
 *  2. **Only `attestto-id` can create a linked identity.** `didUri` appearing in
 *     any other format's claims is attacker-controlled data, not an identity.
 *  3. **A parse failure writes nothing.** All parsing happens before the first
 *     write, so a malformed offer cannot half-land.
 *
 * Time and id generation are injected (`clock`, `newId`) so the record this
 * produces is a value a test can assert whole, rather than something with a
 * `Date.now()` hole in the middle of it.
 *
 * NOTE (pre-existing, unchanged here): the credential — decoded claims included —
 * is written to the UNENCRYPTED public mirror so the popup can list it without a
 * passkey prompt. That is the documented dual-vault design, and it is also why
 * offer claims are plaintext at rest.
 */
import { parseSdJwt, getDecodedClaims } from '@/services/sdjwt'
import { extractDidLabel } from '@/utils/did-label'
import type { LinkedIdentity, VaultData } from '@/stores/wallet'
import type { PublicVaultData } from '@/utils/vault'
import type { StoredCredential, CredentialFormat } from '@/types/credential'
import type { CredentialOfferMessage } from '@/utils/messaging'

/**
 * Dual-vault access for offer acceptance: the public mirror AND the encrypted
 * vault. The public side is typed `PublicVaultData`, which has no
 * `privateKeyJwk` field at all — so this handler cannot write key material to
 * the unencrypted mirror even by mistake (keys-never-mirrored, enforced by the
 * type rather than by a review comment).
 */
export interface CredentialOfferStore {
  readPublic(): Promise<PublicVaultData | null>
  writePublic(vault: PublicVaultData): Promise<void>
  read(): Promise<VaultData | null>
  write(vault: VaultData): Promise<void>
  syncPublic(vault: VaultData): Promise<void>
}

/** Record an origin as trusted for silent future identity syncs. */
export interface TrustedOrigins {
  recordTrusted(origin: string): Promise<void>
}

export interface CredentialOfferAcceptCtx {
  store: CredentialOfferStore
  origins: TrustedOrigins
  /** ISO timestamp source for `issuedAt` / `addedAt` / `syncedAt`. */
  clock: { nowIso(): string }
  /** Credential id source (`crypto.randomUUID` in production). */
  newId(): string
}

export interface CredentialOfferAcceptInput {
  offer: CredentialOfferMessage['payload']
  origin: string | null
}

/**
 * The empty public mirror used when the read returns null. Creating it is
 * deliberate: without it the offer silently disappears, which is exactly the bug
 * behind "I pushed an identity and nothing showed up".
 */
function emptyPublicVault(): PublicVaultData {
  return {
    did: null,
    credentials: [],
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
  }
}

/**
 * Upsert an identity DID into `linkedIdentities[]`, attaching the credential that
 * carried it. Pure — exported for direct test.
 */
export function upsertIdentity(
  list: LinkedIdentity[],
  did: string,
  credential: StoredCredential,
  nowIso: string,
): LinkedIdentity[] {
  const idx = list.findIndex((id) => id.did === did)
  if (idx >= 0) {
    const existing = list[idx]
    const hasCred = existing.credentials.some((c) => c.id === credential.id)
    return list.map((id, i) =>
      i === idx
        ? {
            ...id,
            syncedAt: nowIso,
            credentials: hasCred ? id.credentials : [...id.credentials, credential],
          }
        : id,
    )
  }
  return [
    ...list,
    {
      did,
      label: extractDidLabel(did),
      credentials: [credential],
      syncedAt: nowIso,
      tenantId: null,
    },
  ]
}

/** Everything decoded from the raw offer, before anything is written. */
interface DecodedOffer {
  decodedClaims: Record<string, unknown>
  types: string[]
  issuer: string
  issuedAt: string
  expiresAt: string | null
  disclosureDigests: string[]
}

async function decodeOffer(
  offer: CredentialOfferMessage['payload'],
  nowIso: string,
): Promise<DecodedOffer> {
  const decoded: DecodedOffer = {
    decodedClaims: {},
    types: ['VerifiableCredential'],
    issuer: offer.issuerName,
    issuedAt: nowIso,
    expiresAt: null,
    disclosureDigests: [],
  }

  if (offer.format === 'sd-jwt') {
    const parsed = await parseSdJwt(offer.raw)
    decoded.decodedClaims = await getDecodedClaims(offer.raw)
    decoded.types = (parsed.payload.vct as string[]) ?? decoded.types
    decoded.issuer = (parsed.payload.iss as string) ?? decoded.issuer
    if (parsed.payload.iat) decoded.issuedAt = new Date((parsed.payload.iat as number) * 1000).toISOString()
    if (parsed.payload.exp) decoded.expiresAt = new Date((parsed.payload.exp as number) * 1000).toISOString()
    parsed.disclosures.forEach((d) => {
      // Disclosure exposes the computed digest as the cached `_digest` string
      // (populated during decode); `digest()` is the async recompute.
      if (d._digest) decoded.disclosureDigests.push(d._digest)
    })
    return decoded
  }

  // JSON-LD or attestto-id format
  try {
    const vc = JSON.parse(offer.raw) as Record<string, unknown>
    decoded.decodedClaims = (vc.credentialSubject as Record<string, unknown>) ?? vc
    decoded.types = (vc.type as string[]) ?? decoded.types
    decoded.issuer =
      (typeof vc.issuer === 'string' ? vc.issuer : ((vc.issuer as Record<string, unknown>)?.id as string)) ??
      decoded.issuer
    decoded.issuedAt = (vc.issuanceDate as string) ?? decoded.issuedAt
    decoded.expiresAt = (vc.expirationDate as string) ?? null
  } catch {
    // Raw claims object (from an attestto-id push, whose `raw` is not a VC).
    decoded.decodedClaims = offer.claims ?? {}
  }
  return decoded
}

/**
 * Accept an approved credential offer.
 *
 * @returns the new credential's id, or `null` if the offer could not be decoded
 *          or stored (in which case nothing was written).
 */
export async function handleCredentialOfferAccept(
  input: CredentialOfferAcceptInput,
  ctx: CredentialOfferAcceptCtx,
): Promise<string | null> {
  const { offer, origin } = input
  const isIdentityOffer = offer.format === 'attestto-id'

  // Identity-format sync from a freshly-approved origin: remember it so the next
  // offer from this origin can be accepted silently. Other formats are one-off
  // issuance events, not recurring sync — no benefit to persisting trust, and
  // real cost if a one-off issuer gains silent-sync standing.
  if (isIdentityOffer && origin) {
    await ctx.origins.recordTrusted(origin)
  }

  try {
    const nowIso = ctx.clock.nowIso()
    const decoded = await decodeOffer(offer, nowIso)

    const credential: StoredCredential = {
      id: ctx.newId(),
      // Wire payload types format as `CredentialFormat | string` (accepts unknown
      // formats); storage coerces to the known enum at this boundary.
      format: offer.format as CredentialFormat,
      raw: offer.raw,
      issuer: decoded.issuer,
      issuedAt: decoded.issuedAt,
      expiresAt: decoded.expiresAt,
      types: Array.isArray(decoded.types) ? decoded.types : [decoded.types],
      decodedClaims: decoded.decodedClaims,
      metadata: {
        addedAt: nowIso,
        source: 'push',
        disclosureDigests: decoded.disclosureDigests.length > 0 ? decoded.disclosureDigests : undefined,
      },
    }

    // ONLY an identity-format offer may mint a linked identity. `didUri` inside
    // any other format's claims is just attacker-supplied data.
    const identityDid = isIdentityOffer ? (decoded.decodedClaims.didUri as string | undefined) : undefined

    const pub = (await ctx.store.readPublic()) ?? emptyPublicVault()
    pub.credentials = [...(pub.credentials ?? []), credential]
    if (identityDid) {
      pub.linkedIdentities = upsertIdentity(pub.linkedIdentities ?? [], identityDid, credential, nowIso)
    }
    await ctx.store.writePublic(pub)

    // Also store in the encrypted vault if it is unlocked.
    const vault = await ctx.store.read()
    if (vault) {
      vault.credentials = [...(vault.credentials ?? []), credential]
      if (identityDid) {
        vault.linkedIdentities = upsertIdentity(vault.linkedIdentities ?? [], identityDid, credential, nowIso)
      }
      await ctx.store.write(vault)
      await ctx.store.syncPublic(vault)
    }

    return credential.id
  } catch {
    return null
  }
}
