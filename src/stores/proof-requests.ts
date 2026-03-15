/**
 * Proof Access Request store — manages consent-gated proof requests.
 *
 * Handles the lifecycle: receive request → user reviews fields →
 * approve/decline → generate partial SD-JWT → persist decision.
 */

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { readVault, writeVault } from '@/utils/vault'
import { useWalletStore } from '@/stores/wallet'
import { useCredentialsStore } from '@/stores/credentials'
import { createSdJwtPresentation } from '@/services/sdjwt'
import type { ProofAccessRequest, PreparedPresentation } from '@/types/credential'

export const useProofRequestsStore = defineStore('proofRequests', () => {
  const _requests = ref<ProofAccessRequest[]>([])
  const _preparedPresentations = ref<PreparedPresentation[]>([])
  const walletStore = useWalletStore()

  const requests = computed(() => _requests.value)
  const pendingRequests = computed(() => _requests.value.filter((r) => r.status === 'pending'))
  const preparedPresentations = computed(() => _preparedPresentations.value.filter((p) => !p.used))

  async function loadFromVault(): Promise<void> {
    const vault = await readVault()
    _requests.value = vault?.proofRequests ?? []
    _preparedPresentations.value = vault?.preparedPresentations ?? []
  }

  async function _persist(): Promise<void> {
    const vault = await readVault()
    if (!vault) return
    vault.proofRequests = _requests.value
    vault.preparedPresentations = _preparedPresentations.value
    await writeVault(vault)
  }

  /**
   * Add an incoming proof access request.
   */
  async function addRequest(request: ProofAccessRequest): Promise<void> {
    _requests.value = [..._requests.value, request]
    await _persist()
  }

  /**
   * Approve a request with selected fields. Generates partial SD-JWT.
   * Returns the generated presentation string.
   */
  async function approveRequest(
    requestId: string,
    approvedFields: string[],
  ): Promise<string | null> {
    const idx = _requests.value.findIndex((r) => r.id === requestId)
    if (idx === -1) return null

    const request = _requests.value[idx]
    const credentialsStore = useCredentialsStore()
    const credential = credentialsStore.getById(request.credentialId)
    if (!credential) return null

    const privateKey = walletStore.getPrivateKey()
    if (!privateKey) return null

    try {
      let presentation: string

      if (credential.format === 'sd-jwt') {
        presentation = await createSdJwtPresentation(
          credential.raw,
          approvedFields,
          privateKey,
          request.nonce,
          request.audience,
        )
      } else {
        // JSON-LD: import dynamically to avoid circular deps
        const { createJsonLdVp } = await import('@/services/jsonld-vp')
        presentation = await createJsonLdVp({
          credential: credential.raw,
          holderDid: walletStore.did!,
          holderPrivateKey: privateKey,
          nonce: request.nonce,
        })
      }

      const updated = { ...request }
      updated.approvedFields = approvedFields
      updated.status = 'approved' as const
      updated.decidedAt = new Date().toISOString()

      _requests.value = [
        ..._requests.value.slice(0, idx),
        updated,
        ..._requests.value.slice(idx + 1),
      ]
      await _persist()

      return presentation
    } catch {
      return null
    }
  }

  /**
   * Decline a proof access request.
   */
  async function declineRequest(requestId: string): Promise<void> {
    const idx = _requests.value.findIndex((r) => r.id === requestId)
    if (idx === -1) return

    const updated = { ..._requests.value[idx] }
    updated.status = 'declined' as const
    updated.decidedAt = new Date().toISOString()

    _requests.value = [
      ..._requests.value.slice(0, idx),
      updated,
      ..._requests.value.slice(idx + 1),
    ]
    await _persist()
  }

  /**
   * Store a prepared presentation for push-then-present flow.
   */
  async function addPreparedPresentation(prep: PreparedPresentation): Promise<void> {
    _preparedPresentations.value = [..._preparedPresentations.value, prep]
    await _persist()
  }

  /**
   * Mark a prepared presentation as used.
   */
  async function markPresentationUsed(prepId: string): Promise<void> {
    const idx = _preparedPresentations.value.findIndex((p) => p.id === prepId)
    if (idx === -1) return

    const updated = { ..._preparedPresentations.value[idx] }
    updated.used = true
    updated.usedAt = new Date().toISOString()

    _preparedPresentations.value = [
      ..._preparedPresentations.value.slice(0, idx),
      updated,
      ..._preparedPresentations.value.slice(idx + 1),
    ]
    await _persist()
  }

  /**
   * Get a prepared presentation by ID.
   */
  function getPreparedById(id: string): PreparedPresentation | undefined {
    return _preparedPresentations.value.find((p) => p.id === id)
  }

  /**
   * Remove expired requests and presentations.
   */
  async function pruneExpired(): Promise<void> {
    const now = new Date().toISOString()
    const hadExpired =
      _requests.value.some((r) => r.expiresAt && r.expiresAt < now && r.status === 'pending') ||
      _preparedPresentations.value.some((p) => p.expiresAt < now && !p.used)

    if (!hadExpired) return

    _requests.value = _requests.value.map((r) => {
      if (r.expiresAt && r.expiresAt < now && r.status === 'pending') {
        return { ...r, status: 'expired' as const, decidedAt: now }
      }
      return r
    })

    _preparedPresentations.value = _preparedPresentations.value.filter(
      (p) => p.expiresAt >= now || p.used,
    )

    await _persist()
  }

  function clearOnLock(): void {
    _requests.value = []
    _preparedPresentations.value = []
  }

  // Auto-load/clear on wallet lock state change
  watch(
    () => walletStore.isUnlocked,
    async (unlocked) => {
      if (unlocked) {
        await loadFromVault()
        await pruneExpired()
      } else {
        clearOnLock()
      }
    },
  )

  return {
    requests,
    pendingRequests,
    preparedPresentations,
    loadFromVault,
    addRequest,
    approveRequest,
    declineRequest,
    addPreparedPresentation,
    markPresentationUsed,
    getPreparedById,
    pruneExpired,
    clearOnLock,
  }
})
