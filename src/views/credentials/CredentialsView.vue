<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ShieldCheckIcon,
  BellAlertIcon,
  PaperAirplaneIcon,
} from '@heroicons/vue/24/outline'
import { useCredentialsStore } from '@/stores/credentials'
import { useProofRequestsStore } from '@/stores/proof-requests'
import CredentialCard from '@/components/credentials/CredentialCard.vue'
import EmptyCredentials from '@/components/credentials/EmptyCredentials.vue'

const router = useRouter()
const credentialsStore = useCredentialsStore()
const proofRequestsStore = useProofRequestsStore()

const confirmDeleteId = ref<string | null>(null)

function handleShare(id: string): void {
  router.push(`/credentials/${id}/present`)
}

function handleDelete(id: string): void {
  confirmDeleteId.value = id
}

async function confirmDelete(): Promise<void> {
  if (!confirmDeleteId.value) return
  await credentialsStore.removeCredential(confirmDeleteId.value)
  confirmDeleteId.value = null
}
</script>

<template>
  <div class="space-y-3">
    <!-- Header -->
    <div class="flex items-center gap-2 px-1">
      <ShieldCheckIcon class="h-5 w-5 text-indigo-400" />
      <h2 class="text-sm font-semibold text-white">Verifiable Credentials</h2>
      <span
        v-if="credentialsStore.credentials.length > 0"
        class="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300"
      >
        {{ credentialsStore.credentials.length }}
      </span>
    </div>

    <!-- Pending proof requests banner -->
    <button
      v-if="proofRequestsStore.pendingRequests.length > 0"
      class="w-full rounded-lg border border-amber-700/50 bg-amber-950/20 p-2.5 flex items-center gap-2 hover:bg-amber-950/30 transition-colors"
      @click="router.push(`/consent/${proofRequestsStore.pendingRequests[0].id}`)"
    >
      <BellAlertIcon class="h-4 w-4 text-amber-400 shrink-0" />
      <div class="text-left">
        <p class="text-[11px] font-medium text-amber-300">
          {{ proofRequestsStore.pendingRequests.length }} pending proof request(s)
        </p>
        <p class="text-[10px] text-slate-400">
          {{ proofRequestsStore.pendingRequests[0].requesterName }} is requesting access
        </p>
      </div>
    </button>

    <!-- Prepared presentations link -->
    <button
      v-if="proofRequestsStore.preparedPresentations.length > 0"
      class="w-full rounded-lg border border-indigo-700/30 bg-indigo-950/10 p-2 flex items-center gap-2 hover:bg-indigo-950/20 transition-colors"
      @click="router.push('/credentials/prepared')"
    >
      <PaperAirplaneIcon class="h-4 w-4 text-indigo-400 shrink-0" />
      <span class="text-[11px] text-indigo-300">
        {{ proofRequestsStore.preparedPresentations.length }} prepared presentation(s) ready
      </span>
    </button>

    <!-- Empty state -->
    <EmptyCredentials v-if="credentialsStore.credentials.length === 0" />

    <!-- Credential list -->
    <div v-else class="space-y-2">
      <CredentialCard
        v-for="cred in credentialsStore.credentials"
        :key="cred.id"
        :credential="cred"
        @share="handleShare"
        @delete="handleDelete"
      />
    </div>

    <!-- Delete confirmation overlay -->
    <div
      v-if="confirmDeleteId"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div class="mx-4 w-full max-w-[320px] rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-3">
        <p class="text-sm font-medium text-white">Delete Credential?</p>
        <p class="text-xs text-slate-400">
          This will permanently remove the credential from your wallet.
        </p>
        <div class="flex gap-2">
          <button
            class="flex-1 rounded-md bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
            @click="confirmDeleteId = null"
          >
            Cancel
          </button>
          <button
            class="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500"
            @click="confirmDelete"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
