<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import {
  ShieldCheckIcon,
  XMarkIcon,
  FingerPrintIcon,
} from '@heroicons/vue/24/outline'

const route = useRoute()
const wallet = useWalletStore()

const requestId = ref('')
const origin = ref('')
const loading = ref(true)
const approving = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  requestId.value = (route.query.requestId as string) || ''
  origin.value = (route.query.origin as string) || ''

  if (!requestId.value) {
    error.value = 'No request ID provided'
    loading.value = false
    return
  }

  // Unlock wallet if not already
  if (!wallet.isUnlocked) {
    await wallet.unlock()
  }

  // Verify we have a DID
  if (!wallet.did) {
    error.value = 'No DID created yet. Create a DID first.'
    loading.value = false
    return
  }

  loading.value = false
})

async function approve() {
  approving.value = true
  error.value = null

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CHAPI_APPROVE',
      payload: { requestId: requestId.value },
    })

    if (response?.ok) {
      // Close the popup window
      window.close()
    } else {
      error.value = response?.error || 'Approval failed'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    approving.value = false
  }
}

async function deny() {
  await chrome.runtime.sendMessage({
    type: 'CHAPI_DENY',
    payload: { requestId: requestId.value },
  })
  window.close()
}
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="rounded-lg border border-indigo-700/50 bg-indigo-950/30 p-4 text-center">
      <ShieldCheckIcon class="mx-auto h-8 w-8 text-indigo-400" />
      <p class="mt-2 text-sm font-semibold text-white">Identity Request</p>
      <p class="mt-1 text-xs text-slate-400">
        A site is requesting your identity
      </p>
    </div>

    <!-- Origin -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Requesting site</p>
      <p class="mt-1 text-xs font-mono text-white break-all">{{ origin || 'Unknown' }}</p>
    </div>

    <!-- Loading: wallet unlock -->
    <div v-if="loading" class="rounded-lg border border-slate-700 bg-slate-900 p-4 text-center">
      <p class="text-xs text-slate-400">Unlocking wallet...</p>
    </div>

    <!-- No DID -->
    <div v-else-if="!wallet.did" class="space-y-3">
      <div class="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3">
        <p class="text-xs text-amber-300">No DID found. Create one to continue.</p>
      </div>
      <button
        class="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
        @click="wallet.createDid()"
      >
        Create DID
      </button>
    </div>

    <!-- Ready to approve -->
    <template v-else>
      <!-- Identity to share -->
      <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Your identity</p>
        <div class="mt-2 flex items-center gap-2">
          <FingerPrintIcon class="h-5 w-5 text-emerald-400 shrink-0" />
          <p class="text-xs font-mono text-white break-all">{{ wallet.did }}</p>
        </div>
        <p class="mt-2 text-[10px] text-slate-500">
          This DID will be shared with the requesting site for attribution.
        </p>
      </div>

      <!-- Error -->
      <div v-if="error" class="rounded-lg border border-red-700/50 bg-red-950/30 p-3">
        <p class="text-xs text-red-300">{{ error }}</p>
      </div>

      <!-- Action buttons -->
      <div class="grid grid-cols-2 gap-2">
        <button
          class="rounded-lg border border-slate-700 px-3 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-1.5"
          @click="deny"
        >
          <XMarkIcon class="h-4 w-4" />
          Deny
        </button>
        <button
          class="rounded-lg bg-indigo-600 px-3 py-2.5 text-xs font-medium text-white hover:bg-indigo-500 flex items-center justify-center gap-1.5 disabled:opacity-50"
          :disabled="approving"
          @click="approve"
        >
          <ShieldCheckIcon class="h-4 w-4" />
          {{ approving ? 'Approving...' : 'Approve' }}
        </button>
      </div>
    </template>
  </div>
</template>
