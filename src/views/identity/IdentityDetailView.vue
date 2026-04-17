<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeftIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
} from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import type { LinkedIdentity } from '@/stores/wallet'
import CredentialCard from '@/components/credentials/CredentialCard.vue'

const route = useRoute()
const router = useRouter()
const wallet = useWalletStore()

const did = computed(() => decodeURIComponent(route.params.did as string))

/** Find the matching linked identity from the vault */
const identity = computed<LinkedIdentity | null>(() => {
  return wallet.linkedIdentities.find((id: LinkedIdentity) => id.did === did.value) ?? null
})

const label = computed(() => {
  if (identity.value) return identity.value.label
  const d = did.value
  const snsMatch = d.match(/^did:sns:(.+)$/)
  if (snsMatch) return snsMatch[1]
  return d
})

/** Credentials scoped to this identity */
const credentials = computed(() => identity.value?.credentials ?? [])

const isFetching = ref(false)
const fetchError = ref<string | null>(null)
const fetchSuccess = ref(false)

function goBack(): void {
  router.push({ name: 'home' })
}

function handleShare(id: string): void {
  router.push(`/credentials/${id}/present`)
}

async function handleFetchFromVault(): Promise<void> {
  isFetching.value = true
  fetchError.value = null
  fetchSuccess.value = false
  try {
    const fetched = await wallet.fetchFromVault(did.value)
    fetchSuccess.value = true
    setTimeout(() => { fetchSuccess.value = false }, 3000)
    if (fetched.length === 0) {
      fetchError.value = 'No credentials found on the platform for this identity'
    }
  } catch (err) {
    fetchError.value = err instanceof Error ? err.message : 'Failed to fetch credentials'
  } finally {
    isFetching.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <!-- Back + title -->
    <button
      class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
      @click="goBack"
    >
      <ArrowLeftIcon class="h-3.5 w-3.5" />
      Back
    </button>

    <div class="px-1">
      <p class="text-sm font-semibold text-white">{{ label }}</p>
    </div>

    <!-- Credentials -->
    <div class="space-y-2">
      <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Credentials
      </p>

      <CredentialCard
        v-for="cred in credentials"
        :key="cred.id"
        :credential="cred"
        @share="handleShare"
      />

      <!-- Empty state -->
      <div
        v-if="credentials.length === 0"
        class="rounded-lg border border-slate-700 bg-slate-900 p-4 text-center"
      >
        <p class="text-xs text-slate-400">No credentials for this identity</p>
      </div>

      <!-- Fetch status -->
      <p v-if="fetchError" class="px-1 text-[10px] text-red-400">{{ fetchError }}</p>
      <p v-if="fetchSuccess" class="px-1 text-[10px] text-emerald-400">Credentials synced</p>

      <!-- Fetch from Vault -->
      <button
        :disabled="isFetching"
        class="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-600 bg-slate-900/50 p-3 text-xs text-slate-400 hover:border-indigo-500 hover:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        @click="handleFetchFromVault"
      >
        <ArrowPathIcon v-if="isFetching" class="h-4 w-4 animate-spin" />
        <ArrowDownTrayIcon v-else class="h-4 w-4" />
        {{ isFetching ? 'Fetching...' : 'Fetch from Vault' }}
      </button>
    </div>
  </div>
</template>
