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

  if (!wallet.isUnlocked) {
    await wallet.unlock()
  }

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
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <!-- Header -->
    <div class="ext-header-banner ext-header-banner--identity" style="text-align: center">
      <ShieldCheckIcon style="margin: 0 auto; width: 2rem; height: 2rem; color: var(--ext-brand-secondary)" />
      <p class="ext-header-banner__title" style="margin-top: 0.5rem">Identity Request</p>
      <p class="ext-header-banner__subtitle">A site is requesting your identity</p>
    </div>

    <!-- Origin -->
    <div class="ext-card">
      <p class="ext-detail__label">Requesting site</p>
      <p class="ext-detail__value" style="font-family: monospace">{{ origin || 'Unknown' }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="ext-card" style="text-align: center; padding: 1rem">
      <p style="font-size: var(--ext-text-xs); color: var(--ext-text-secondary)">Unlocking wallet...</p>
    </div>

    <!-- No DID -->
    <div v-else-if="!wallet.did" style="display: flex; flex-direction: column; gap: 0.75rem">
      <div class="ext-info-box ext-info-box--warning">
        No DID found. Create one to continue.
      </div>
      <button class="ext-btn ext-btn--ghost ext-btn--md" style="width: 100%" @click="wallet.createDid()">
        Create DID
      </button>
    </div>

    <!-- Ready to approve -->
    <template v-else>
      <div class="ext-card">
        <p class="ext-detail__label">Your identity</p>
        <div style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem">
          <FingerPrintIcon style="width: 1.25rem; height: 1.25rem; color: var(--ext-success); flex-shrink: 0" />
          <p class="ext-detail__value" style="font-family: monospace">{{ wallet.did }}</p>
        </div>
        <p style="margin-top: 0.5rem; font-size: var(--ext-text-2xs); color: var(--ext-text-muted)">
          This DID will be shared with the requesting site for attribution.
        </p>
      </div>

      <!-- Error -->
      <div v-if="error" class="ext-info-box ext-info-box--error">{{ error }}</div>

      <!-- Action buttons -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem">
        <button class="ext-btn ext-btn--ghost ext-btn--md" @click="deny">
          <XMarkIcon style="width: 1rem; height: 1rem" />
          Deny
        </button>
        <button class="ext-btn ext-btn--primary ext-btn--md" :disabled="approving" @click="approve">
          <ShieldCheckIcon style="width: 1rem; height: 1rem" />
          {{ approving ? 'Approving...' : 'Approve' }}
        </button>
      </div>
    </template>
  </div>
</template>
