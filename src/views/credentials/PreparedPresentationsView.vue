<script setup lang="ts">
/**
 * Prepared Presentations — Push-then-Present flow.
 *
 * Shows VPs that were pre-built from the Attestto dashboard and
 * pushed to the extension. Ready to present to verifiers on demand.
 */

import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeftIcon,
  PaperAirplaneIcon,
  ClockIcon,
  CheckBadgeIcon,
} from '@heroicons/vue/24/outline'
import { useProofRequestsStore } from '@/stores/proof-requests'
import { useCredentialsStore } from '@/stores/credentials'

const router = useRouter()
const proofRequestsStore = useProofRequestsStore()
const credentialsStore = useCredentialsStore()

const presentations = computed(() => proofRequestsStore.preparedPresentations)

function credentialLabel(credentialId: string): string {
  const cred = credentialsStore.getById(credentialId)
  if (!cred) return 'Unknown'
  return cred.types[cred.types.length - 1] || 'Verifiable Credential'
}

function timeRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m remaining`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h remaining`
  return `${Math.floor(hours / 24)}d remaining`
}

async function copyPresentation(id: string): Promise<void> {
  const prep = proofRequestsStore.getPreparedById(id)
  if (!prep) return
  await navigator.clipboard.writeText(prep.presentation)
  await proofRequestsStore.markPresentationUsed(id)
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <!-- Header -->
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <button
        style="border-radius: var(--ext-radius-md); padding: 0.25rem; cursor: pointer; background: none; border: none; color: var(--ext-text-secondary)"
        @click="router.push('/credentials')"
      >
        <ArrowLeftIcon style="width: 1rem; height: 1rem" />
      </button>
      <PaperAirplaneIcon style="width: 1rem; height: 1rem; color: var(--ext-brand-secondary)" />
      <h2 style="font-size: var(--ext-text-md); font-weight: 600; color: var(--ext-text-primary)">Prepared Presentations</h2>
      <span v-if="presentations.length > 0" class="ext-badge ext-badge--brand" style="margin-left: auto">
        {{ presentations.length }}
      </span>
    </div>

    <!-- Empty -->
    <div v-if="presentations.length === 0" class="ext-empty" style="padding: 1.5rem">
      <PaperAirplaneIcon class="ext-empty__icon" />
      <p class="ext-empty__title">No prepared presentations</p>
      <p class="ext-empty__desc">
        Use "Push to Vault" from the Attestto Share Credential page
        to pre-build presentations for later use.
      </p>
    </div>

    <!-- Presentation cards -->
    <div
      v-for="prep in presentations"
      :key="prep.id"
      class="ext-card"
      style="display: flex; flex-direction: column; gap: 0.5rem"
    >
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <CheckBadgeIcon style="width: 1rem; height: 1rem; color: var(--ext-success)" />
        <span style="font-size: var(--ext-text-xs); color: var(--ext-text-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          {{ credentialLabel(prep.credentialId) }}
        </span>
      </div>

      <!-- Fields -->
      <div style="display: flex; flex-wrap: wrap; gap: 0.25rem">
        <span
          v-for="field in prep.selectedFields"
          :key="field"
          class="ext-badge ext-badge--brand"
        >
          {{ field }}
        </span>
      </div>

      <!-- Expiry -->
      <div style="display: flex; align-items: center; gap: 0.25rem; font-size: var(--ext-text-2xs)">
        <ClockIcon style="width: 0.75rem; height: 0.75rem; color: var(--ext-text-muted)" />
        <span :style="{ color: timeRemaining(prep.expiresAt) === 'Expired' ? 'var(--ext-error)' : 'var(--ext-text-secondary)' }">
          {{ timeRemaining(prep.expiresAt) }}
        </span>
      </div>

      <!-- Present button -->
      <button
        class="ext-btn ext-btn--primary ext-btn--sm"
        style="width: 100%"
        :disabled="timeRemaining(prep.expiresAt) === 'Expired'"
        @click="copyPresentation(prep.id)"
      >
        Copy & Present
      </button>
    </div>
  </div>
</template>
