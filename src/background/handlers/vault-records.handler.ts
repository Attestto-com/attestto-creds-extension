/**
 * Story 1.13 Phase 10 — the three "record this into the vault" flows.
 *
 * `PROOF_ACCESS_REQUEST`, `PUSH_PRESENTATION` and `WALLET_LINK` all did the same
 * thing inline in a message case: mint a record with `Date.now()` and
 * `Math.random()`, append it to a vault array, write, mirror. Two things make
 * them worth stating once rather than three times.
 *
 * **The dual-vault rule.** Every `write` here MUST be followed by `syncPublic`,
 * or the change lives only in the encrypted vault and the popup — which reads
 * the public mirror without a passkey — never sees it. That rule is written down
 * in the repo CLAUDE.md because breaking it produced the "I synced an identity
 * and nothing showed up" class of bug. It is now enforced by a test instead of
 * by remembering.
 *
 * **A locked vault stores nothing.** Each of these returns `stored: false` in
 * that case, honestly, rather than implying the record landed. The message cases
 * currently discard that flag and answer `ok: true` with a fresh id either way —
 * which means a proof-access request received while the wallet is locked is
 * acknowledged and then dropped. That is pre-existing behaviour, preserved at
 * the call site and NOT laundered here: the handler tells the truth, and the one
 * line that ignores it is visible in `background.ts`.
 *
 * Records are built field by field from named inputs, never spread from the
 * payload. A requester must not be able to ship `status: 'approved'` or a
 * populated `approvedFields` and have it stored.
 */
import type { VaultData } from '@/stores/wallet'
import type { ProofAccessRequest, PreparedPresentation } from '@/types/credential'
import type { ProofAccessRequestMessage, PushPresentationMessage } from '@/utils/messaging'

/** Read/write/mirror over the encrypted vault. `syncPublic` is not optional — see above. */
export interface VaultRecordStore {
  read(): Promise<VaultData | null>
  write(vault: VaultData): Promise<void>
  syncPublic(vault: VaultData): Promise<void>
}

export interface VaultRecordCtx {
  store: VaultRecordStore
  clock: { nowIso(): string }
  /** Record id source, e.g. `par-<ts>-<rand>`. Injected so records are assertable. */
  newId(prefix: string): string
}

/** `stored: false` means the vault was locked and the record went nowhere. */
export interface RecordResult<T> {
  record: T
  stored: boolean
}

/**
 * Append to one of the vault's record arrays, then mirror. The mutate callback
 * receives the vault and returns nothing; the write+mirror pair is applied here
 * so no caller can perform one without the other.
 */
async function appendAndMirror(
  store: VaultRecordStore,
  mutate: (vault: VaultData) => void,
): Promise<boolean> {
  const vault = await store.read()
  if (!vault) return false
  mutate(vault)
  await store.write(vault)
  await store.syncPublic(vault)
  return true
}

/**
 * Record an inbound proof-access request as PENDING.
 *
 * `status` and `approvedFields` are set here, not taken from the payload: a
 * requester cannot deliver a request that is already approved.
 */
export async function recordProofAccessRequest(
  payload: ProofAccessRequestMessage['payload'],
  ctx: VaultRecordCtx,
): Promise<RecordResult<ProofAccessRequest>> {
  const record: ProofAccessRequest = {
    id: ctx.newId('par'),
    credentialId: payload.credentialId,
    requesterDid: payload.requesterDid,
    requesterName: payload.requesterName,
    purpose: payload.purpose,
    requestedFields: payload.requestedFields,
    approvedFields: [],
    status: 'pending',
    receivedAt: ctx.clock.nowIso(),
    decidedAt: null,
    expiresAt: payload.expiresAt,
    transport: payload.transport,
    nonce: payload.nonce,
    audience: payload.audience,
  }

  const stored = await appendAndMirror(ctx.store, (vault) => {
    vault.proofRequests = [...(vault.proofRequests ?? []), record]
  })
  return { record, stored }
}

/**
 * Record a prepared presentation as UNUSED. `used`/`usedAt` are set here so a
 * pushed presentation cannot arrive pre-marked as spent.
 */
export async function recordPreparedPresentation(
  payload: PushPresentationMessage['payload'],
  ctx: VaultRecordCtx,
): Promise<RecordResult<PreparedPresentation>> {
  const record: PreparedPresentation = {
    id: ctx.newId('prep'),
    credentialId: payload.credentialId,
    presentation: payload.presentation,
    selectedFields: payload.selectedFields,
    createdAt: ctx.clock.nowIso(),
    expiresAt: payload.expiresAt,
    used: false,
    usedAt: null,
  }

  const stored = await appendAndMirror(ctx.store, (vault) => {
    vault.preparedPresentations = [...(vault.preparedPresentations ?? []), record]
  })
  return { record, stored }
}

export type WalletLinkResult =
  | { ok: false; error: string }
  | { ok: true; stored: boolean }

/** Link a Solana address to the wallet. Overwrites any previous link. */
export async function linkWalletAddress(
  address: string | undefined,
  ctx: Pick<VaultRecordCtx, 'store'>,
): Promise<WalletLinkResult> {
  if (!address) return { ok: false, error: 'No address provided' }

  const stored = await appendAndMirror(ctx.store, (vault) => {
    vault.linkedSolanaAddress = address
  })
  return { ok: true, stored }
}
