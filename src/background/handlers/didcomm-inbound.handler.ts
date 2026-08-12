/**
 * Story 1.9 — the `DIDCOMM_INBOUND` handler, extracted from the legacy switch
 * (`background.ts:1540`) as a near-verbatim move: same notification options, same
 * forward shape, same null-guard, same always-ok — only the `chrome.*` calls are
 * swapped for injected `ctx` ports so it is importable and characterized.
 *
 * `parseProofRequest` stays a plain import (pure, AD-4). The handler owns the
 * exact notification/forward content so parity is pinned HERE (Story 1.9); the
 * ctx adapter that binds these ports to `chrome.*` is a thin passthrough wired at
 * the composition root (Story 1.13). Pure module: no `chrome.*` at import.
 *
 * Parity note (AD-9 seam): this handler does NO sender-auth — matching the legacy
 * case. The route declares a `verifyPeer: { check: 'envelope' }` slot, filled and
 * enforced (via the full pipeline) in Epic 2. The switch case therefore delegates
 * to `handle` DIRECTLY, not through `dispatch` (whose empty `allowFrom` would
 * reject every inbound) — see the parity spec.
 */
import { parseProofRequest } from '@/services/didcomm'
import type { UntrustedCtx } from '@/background/ctx/ctx-bundles'

export async function handleDidcommInbound(
  payload: unknown,
  ctx: Pick<UntrustedCtx, 'notifications' | 'runtime'>,
): Promise<{ ok: true }> {
  const parsed = parseProofRequest(payload)

  if (parsed) {
    await ctx.notifications.create(`didcomm-${parsed.id}`, {
      type: 'basic',
      iconUrl: ctx.runtime.getURL('icon/48.png'),
      title: 'DIDComm Proof Request',
      message: `${parsed.from} is requesting identity verification via DIDComm v2.`,
      buttons: [{ title: 'Review' }, { title: 'Dismiss' }],
      requireInteraction: true,
    })

    await ctx.runtime.sendMessage({ type: 'DIDCOMM_PROOF_REQUEST', payload: parsed })
  }

  return { ok: true }
}
