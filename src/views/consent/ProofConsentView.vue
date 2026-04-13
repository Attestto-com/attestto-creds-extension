<script setup lang="ts">
/**
 * Proof Access Consent — field-level approval/decline popup.
 *
 * Shown when a verifier requests access to specific credential fields.
 * The user can:
 *   - See which fields are requested and by whom
 *   - Select/deselect individual fields
 *   - Approve (generates partial SD-JWT with only approved fields)
 *   - Decline (sends problem report back to verifier)
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeftIcon,
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/vue/24/outline'
import { useProofRequestsStore } from '@/stores/proof-requests'
import { useCredentialsStore } from '@/stores/credentials'
import type { ProofAccessRequest } from '@/types/credential'

const route = useRoute()
const router = useRouter()
const proofRequestsStore = useProofRequestsStore()
const credentialsStore = useCredentialsStore()

const request = ref<ProofAccessRequest | null>(null)
const fieldSelections = ref<Array<{ name: string; selected: boolean }>>([])
const processing = ref(false)
const error = ref('')
const result = ref<'approved' | 'declined' | null>(null)
const generatedPresentation = ref('')

const credentialLabel = computed(() => {
  if (!request.value) return ''
  const cred = credentialsStore.getById(request.value.credentialId)
  if (!cred) return 'Unknown Credential'
  return cred.types[cred.types.length - 1] || 'Verifiable Credential'
})

const hasSelection = computed(() => fieldSelections.value.some((f) => f.selected))

const selectedCount = computed(() => fieldSelections.value.filter((f) => f.selected).length)

onMounted(() => {
  const requestId = route.params.id as string
  const found = proofRequestsStore.requests.find((r) => r.id === requestId)
  if (!found || found.status !== 'pending') {
    router.replace('/credentials')
    return
  }
  request.value = found
  fieldSelections.value = found.requestedFields.map((name) => ({
    name,
    selected: true,
  }))
})

async function approve(): Promise<void> {
  if (!request.value || processing.value) return
  processing.value = true
  error.value = ''

  const approved = fieldSelections.value.filter((f) => f.selected).map((f) => f.name)
  const presentation = await proofRequestsStore.approveRequest(request.value.id, approved)

  if (presentation) {
    generatedPresentation.value = presentation
    result.value = 'approved'
  } else {
    error.value = 'Failed to generate presentation'
  }
  processing.value = false
}

async function decline(): Promise<void> {
  if (!request.value || processing.value) return
  processing.value = true

  await proofRequestsStore.declineRequest(request.value.id)
  result.value = 'declined'
  processing.value = false
}

function selectAll(): void {
  fieldSelections.value = fieldSelections.value.map((f) => ({ ...f, selected: true }))
}

function selectNone(): void {
  fieldSelections.value = fieldSelections.value.map((f) => ({ ...f, selected: false }))
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <!-- Back -->
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <button
        style="border-radius: var(--ext-radius-md); padding: 0.25rem; cursor: pointer; background: none; border: none; color: var(--ext-text-secondary)"
        @click="router.push('/credentials')"
      >
        <ArrowLeftIcon style="width: 1rem; height: 1rem" />
      </button>
      <h2 style="font-size: var(--ext-text-md); font-weight: 600; color: var(--ext-text-primary)">Proof Request</h2>
    </div>

    <!-- Result: Approved -->
    <template v-if="result === 'approved'">
      <div class="ext-header-banner ext-header-banner--pay" style="text-align: center; display: flex; flex-direction: column; gap: 0.5rem">
        <CheckCircleIcon style="width: 2rem; height: 2rem; color: var(--ext-success); margin: 0 auto" />
        <p style="font-size: var(--ext-text-md); font-weight: 500; color: var(--ext-success)">Presentation Shared</p>
        <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-secondary)">
          {{ selectedCount }} field(s) disclosed to {{ request?.requesterName }}
        </p>
      </div>
      <button class="ext-btn ext-btn--ghost ext-btn--md" style="width: 100%" @click="router.push('/credentials')">
        Back to Credentials
      </button>
    </template>

    <!-- Result: Declined -->
    <template v-else-if="result === 'declined'">
      <div class="ext-header-banner ext-header-banner--auth" style="text-align: center; display: flex; flex-direction: column; gap: 0.5rem; border-color: rgba(239, 68, 68, 0.3); background: rgba(127, 29, 29, 0.3)">
        <XCircleIcon style="width: 2rem; height: 2rem; color: var(--ext-error); margin: 0 auto" />
        <p style="font-size: var(--ext-text-md); font-weight: 500; color: var(--ext-error)">Request Declined</p>
        <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-secondary)">
          No data was shared with {{ request?.requesterName }}
        </p>
      </div>
      <button class="ext-btn ext-btn--ghost ext-btn--md" style="width: 100%" @click="router.push('/credentials')">
        Back to Credentials
      </button>
    </template>

    <!-- Consent Form -->
    <template v-else-if="request">
      <!-- Requester info -->
      <div class="ext-info-box ext-info-box--warning" style="display: flex; align-items: flex-start; gap: 0.5rem">
        <ExclamationTriangleIcon style="width: 1rem; height: 1rem; margin-top: 0.125rem; flex-shrink: 0" />
        <div>
          <p style="font-size: var(--ext-text-xs); font-weight: 500">
            {{ request.requesterName }} is requesting access
          </p>
          <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-secondary); margin-top: 0.125rem">
            {{ request.purpose }}
          </p>
        </div>
      </div>

      <!-- Credential reference -->
      <div class="ext-card">
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <ShieldCheckIcon style="width: 1rem; height: 1rem; color: var(--ext-brand-secondary)" />
          <span style="font-size: var(--ext-text-xs); color: var(--ext-text-primary); font-weight: 500">{{ credentialLabel }}</span>
        </div>
        <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-muted); margin-top: 0.25rem">
          Via {{ request.transport === 'didcomm_v2' ? 'DIDComm v2 (P2P encrypted)' : request.transport === 'push_to_vault' ? 'Push to Vault' : 'Attestto Platform' }}
        </p>
      </div>

      <!-- Field selection -->
      <div class="ext-card" style="display: flex; flex-direction: column; gap: 0.5rem">
        <div style="display: flex; align-items: center; justify-content: space-between">
          <p class="ext-detail__label" style="margin-bottom: 0">Requested Fields</p>
          <div style="display: flex; gap: 0.5rem">
            <button
              style="font-size: 9px; color: var(--ext-brand-secondary); cursor: pointer; background: none; border: none"
              @click="selectAll"
            >All</button>
            <button
              style="font-size: 9px; color: var(--ext-text-muted); cursor: pointer; background: none; border: none"
              @click="selectNone"
            >None</button>
          </div>
        </div>

        <label
          v-for="(field, idx) in fieldSelections"
          :key="idx"
          style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.25rem; border-radius: var(--ext-radius-sm)"
        >
          <input
            v-model="field.selected"
            type="checkbox"
            style="width: 0.875rem; height: 0.875rem"
          />
          <component
            :is="field.selected ? EyeIcon : EyeSlashIcon"
            style="width: 0.875rem; height: 0.875rem"
            :style="{ color: field.selected ? 'var(--ext-brand-secondary)' : 'var(--ext-text-dim)' }"
          />
          <span
            style="font-size: var(--ext-text-xs)"
            :style="{ color: field.selected ? 'var(--ext-text-primary)' : 'var(--ext-text-muted)', textDecoration: field.selected ? 'none' : 'line-through' }"
          >
            {{ field.name }}
          </span>
        </label>
      </div>

      <!-- Error -->
      <p v-if="error" style="font-size: var(--ext-text-xs); color: var(--ext-error)">{{ error }}</p>

      <!-- Actions -->
      <div style="display: flex; gap: 0.5rem">
        <button class="ext-btn ext-btn--ghost ext-btn--md" style="flex: 1" :disabled="processing" @click="decline">
          Decline
        </button>
        <button
          class="ext-btn ext-btn--md"
          :class="hasSelection ? 'ext-btn--primary' : 'ext-btn--ghost'"
          style="flex: 1"
          :disabled="!hasSelection || processing"
          @click="approve"
        >
          {{ processing ? 'Generating...' : `Approve (${selectedCount})` }}
        </button>
      </div>

      <!-- Disclosure notice -->
      <p style="font-size: 9px; color: var(--ext-text-dim); text-align: center">
        Only the selected fields will be shared. Other credential data remains private.
      </p>
    </template>
  </div>
</template>
