<script setup lang="ts">
/**
 * Prepared Presentations — Push-then-Present flow.
 *
 * Shows VPs that were pre-built from the CORTEX dashboard and
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
  <div class="space-y-3">
    <!-- Header -->
    <div class="flex items-center gap-2">
      <button
        class="rounded-md p-1 hover:bg-slate-800 transition-colors"
        @click="router.push('/credentials')"
      >
        <ArrowLeftIcon class="h-4 w-4 text-slate-400" />
      </button>
      <PaperAirplaneIcon class="h-4 w-4 text-indigo-400" />
      <h2 class="text-sm font-semibold text-white">Prepared Presentations</h2>
      <span
        v-if="presentations.length > 0"
        class="ml-auto rounded-full bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-300"
      >
        {{ presentations.length }}
      </span>
    </div>

    <!-- Empty -->
    <div
      v-if="presentations.length === 0"
      class="rounded-lg border border-slate-700 bg-slate-900 p-6 text-center space-y-2"
    >
      <PaperAirplaneIcon class="h-8 w-8 text-slate-600 mx-auto" />
      <p class="text-xs text-slate-400">No prepared presentations</p>
      <p class="text-[10px] text-slate-500">
        Use "Push to Vault" from the CORTEX Share Credential page
        to pre-build presentations for later use.
      </p>
    </div>

    <!-- Presentation cards -->
    <div
      v-for="prep in presentations"
      :key="prep.id"
      class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2"
    >
      <div class="flex items-center gap-2">
        <CheckBadgeIcon class="h-4 w-4 text-emerald-400" />
        <span class="text-xs text-white font-medium truncate">
          {{ credentialLabel(prep.credentialId) }}
        </span>
      </div>

      <!-- Fields -->
      <div class="flex flex-wrap gap-1">
        <span
          v-for="field in prep.selectedFields"
          :key="field"
          class="rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[9px] text-indigo-300"
        >
          {{ field }}
        </span>
      </div>

      <!-- Expiry -->
      <div class="flex items-center gap-1 text-[10px]">
        <ClockIcon class="h-3 w-3 text-slate-500" />
        <span
          :class="timeRemaining(prep.expiresAt) === 'Expired' ? 'text-red-400' : 'text-slate-400'"
        >
          {{ timeRemaining(prep.expiresAt) }}
        </span>
      </div>

      <!-- Present button -->
      <button
        class="w-full rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-40"
        :disabled="timeRemaining(prep.expiresAt) === 'Expired'"
        @click="copyPresentation(prep.id)"
      >
        Copy & Present
      </button>
    </div>
  </div>
</template>
