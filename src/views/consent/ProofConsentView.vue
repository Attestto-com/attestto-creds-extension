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
  <div class="space-y-3">
    <!-- Back -->
    <div class="flex items-center gap-2">
      <button
        class="rounded-md p-1 hover:bg-slate-800 transition-colors"
        @click="router.push('/credentials')"
      >
        <ArrowLeftIcon class="h-4 w-4 text-slate-400" />
      </button>
      <h2 class="text-sm font-semibold text-white">Proof Request</h2>
    </div>

    <!-- Result: Approved -->
    <template v-if="result === 'approved'">
      <div class="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 text-center space-y-2">
        <CheckCircleIcon class="h-8 w-8 text-emerald-400 mx-auto" />
        <p class="text-sm font-medium text-emerald-300">Presentation Shared</p>
        <p class="text-[10px] text-slate-400">
          {{ selectedCount }} field(s) disclosed to {{ request?.requesterName }}
        </p>
      </div>
      <button
        class="w-full rounded-md bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700"
        @click="router.push('/credentials')"
      >
        Back to Credentials
      </button>
    </template>

    <!-- Result: Declined -->
    <template v-else-if="result === 'declined'">
      <div class="rounded-lg border border-red-700/50 bg-red-950/20 p-4 text-center space-y-2">
        <XCircleIcon class="h-8 w-8 text-red-400 mx-auto" />
        <p class="text-sm font-medium text-red-300">Request Declined</p>
        <p class="text-[10px] text-slate-400">
          No data was shared with {{ request?.requesterName }}
        </p>
      </div>
      <button
        class="w-full rounded-md bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700"
        @click="router.push('/credentials')"
      >
        Back to Credentials
      </button>
    </template>

    <!-- Consent Form -->
    <template v-else-if="request">
      <!-- Requester info -->
      <div class="rounded-lg border border-amber-700/50 bg-amber-950/20 p-3 space-y-1">
        <div class="flex items-start gap-2">
          <ExclamationTriangleIcon class="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p class="text-xs font-medium text-amber-300">
              {{ request.requesterName }} is requesting access
            </p>
            <p class="text-[10px] text-slate-400 mt-0.5">
              {{ request.purpose }}
            </p>
          </div>
        </div>
      </div>

      <!-- Credential reference -->
      <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
        <div class="flex items-center gap-2">
          <ShieldCheckIcon class="h-4 w-4 text-indigo-400" />
          <span class="text-xs text-white font-medium">{{ credentialLabel }}</span>
        </div>
        <p class="text-[10px] text-slate-500 mt-1">
          Via {{ request.transport === 'didcomm_v2' ? 'DIDComm v2 (P2P encrypted)' : request.transport === 'push_to_vault' ? 'Push to Vault' : 'Attestto Platform' }}
        </p>
      </div>

      <!-- Field selection -->
      <div class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2">
        <div class="flex items-center justify-between">
          <p class="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
            Requested Fields
          </p>
          <div class="flex gap-2">
            <button
              class="text-[9px] text-indigo-400 hover:text-indigo-300"
              @click="selectAll"
            >
              All
            </button>
            <button
              class="text-[9px] text-slate-500 hover:text-slate-400"
              @click="selectNone"
            >
              None
            </button>
          </div>
        </div>

        <label
          v-for="(field, idx) in fieldSelections"
          :key="idx"
          class="flex items-center gap-2 cursor-pointer py-1 rounded px-1 hover:bg-slate-800/50 transition-colors"
        >
          <input
            v-model="field.selected"
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
          />
          <component
            :is="field.selected ? EyeIcon : EyeSlashIcon"
            class="h-3.5 w-3.5"
            :class="field.selected ? 'text-indigo-400' : 'text-slate-600'"
          />
          <span
            class="text-[11px]"
            :class="field.selected ? 'text-slate-200' : 'text-slate-500 line-through'"
          >
            {{ field.name }}
          </span>
        </label>
      </div>

      <!-- Error -->
      <p v-if="error" class="text-[11px] text-red-400">{{ error }}</p>

      <!-- Actions -->
      <div class="flex gap-2">
        <button
          class="flex-1 rounded-md bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
          :disabled="processing"
          @click="decline"
        >
          Decline
        </button>
        <button
          class="flex-1 rounded-md px-3 py-2 text-xs font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          :class="hasSelection ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-slate-700'"
          :disabled="!hasSelection || processing"
          @click="approve"
        >
          {{ processing ? 'Generating...' : `Approve (${selectedCount})` }}
        </button>
      </div>

      <!-- Disclosure notice -->
      <p class="text-[9px] text-slate-600 text-center">
        Only the selected fields will be shared. Other credential data remains private.
      </p>
    </template>
  </div>
</template>
