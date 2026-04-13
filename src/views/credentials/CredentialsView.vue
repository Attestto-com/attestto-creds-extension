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
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <!-- Header -->
    <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0 0.25rem">
      <ShieldCheckIcon style="width: 1.25rem; height: 1.25rem; color: var(--ext-brand-secondary)" />
      <h2 style="font-size: var(--ext-text-md); font-weight: 600; color: var(--ext-text-primary)">Verifiable Credentials</h2>
      <span
        v-if="credentialsStore.credentials.length > 0"
        class="ext-badge ext-badge--muted"
        style="margin-left: auto"
      >
        {{ credentialsStore.credentials.length }}
      </span>
    </div>

    <!-- Pending proof requests banner -->
    <button
      v-if="proofRequestsStore.pendingRequests.length > 0"
      class="ext-info-box ext-info-box--warning"
      style="width: 100%; display: flex; align-items: center; gap: 0.5rem; cursor: pointer; text-align: left"
      @click="router.push(`/consent/${proofRequestsStore.pendingRequests[0].id}`)"
    >
      <BellAlertIcon style="width: 1rem; height: 1rem; flex-shrink: 0" />
      <div>
        <p style="font-size: var(--ext-text-xs); font-weight: 500">
          {{ proofRequestsStore.pendingRequests.length }} pending proof request(s)
        </p>
        <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-secondary)">
          {{ proofRequestsStore.pendingRequests[0].requesterName }} is requesting access
        </p>
      </div>
    </button>

    <!-- Prepared presentations link -->
    <button
      v-if="proofRequestsStore.preparedPresentations.length > 0"
      class="ext-info-box ext-info-box--info"
      style="width: 100%; display: flex; align-items: center; gap: 0.5rem; cursor: pointer"
      @click="router.push('/credentials/prepared')"
    >
      <PaperAirplaneIcon style="width: 1rem; height: 1rem; flex-shrink: 0" />
      <span style="font-size: var(--ext-text-xs)">
        {{ proofRequestsStore.preparedPresentations.length }} prepared presentation(s) ready
      </span>
    </button>

    <!-- Empty state -->
    <EmptyCredentials v-if="credentialsStore.credentials.length === 0" />

    <!-- Credential list -->
    <div v-else style="display: flex; flex-direction: column; gap: 0.5rem">
      <CredentialCard
        v-for="cred in credentialsStore.credentials"
        :key="cred.id"
        :credential="cred"
        @share="handleShare"
        @delete="handleDelete"
      />
    </div>

    <!-- Delete confirmation overlay -->
    <div v-if="confirmDeleteId" class="ext-overlay">
      <div class="ext-modal" style="display: flex; flex-direction: column; gap: 0.75rem">
        <p style="font-size: var(--ext-text-md); font-weight: 500; color: var(--ext-text-primary)">Delete Credential?</p>
        <p style="font-size: var(--ext-text-xs); color: var(--ext-text-secondary)">
          This will permanently remove the credential from your wallet.
        </p>
        <div style="display: flex; gap: 0.5rem">
          <button class="ext-btn ext-btn--ghost ext-btn--md" style="flex: 1" @click="confirmDeleteId = null">
            Cancel
          </button>
          <button class="ext-btn ext-btn--danger ext-btn--md" style="flex: 1" @click="confirmDelete">
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
