<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useWalletStore } from '@/stores/wallet'
import {
  ShieldCheckIcon,
  XMarkIcon,
  FingerPrintIcon,
  LockClosedIcon,
  KeyIcon,
} from '@heroicons/vue/24/outline'

const wallet = useWalletStore()

const requestId = ref('')
const origin = ref('')
const loading = ref(true)
const approving = ref(false)
const error = ref<string | null>(null)

/** Available DIDs the user can choose from */
interface AvailableDid {
  did: string
  label: string
  method: string
}

const availableDids = computed<AvailableDid[]>(() => {
  const dids: AvailableDid[] = []
  if (wallet.did) {
    const method = wallet.did.split(':').slice(0, 2).join(':')
    dids.push({ did: wallet.did, label: 'Wallet Key', method })
  }
  return dids
})

const selectedDid = ref<string | null>(null)

onMounted(async () => {
  const params = new URLSearchParams(window.location.search)
  requestId.value = params.get('chapiRequest') || ''
  origin.value = params.get('origin') || ''

  if (!requestId.value) {
    error.value = 'No request ID'
    loading.value = false
    return
  }

  if (!wallet.isUnlocked) {
    try {
      await wallet.unlock()
    } catch {
      // Vault doesn't exist yet
    }
  }

  if (wallet.did) {
    selectedDid.value = wallet.did
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

async function createDidAndRetry() {
  await wallet.createDid()
  if (wallet.did) {
    selectedDid.value = wallet.did
  }
}
</script>

<template>
  <div style="max-width: 24rem; margin: 0 auto; padding: 1rem; display: flex; flex-direction: column; gap: 1rem">
    <!-- Header -->
    <div class="ext-header-banner ext-header-banner--identity" style="text-align: center">
      <ShieldCheckIcon style="margin: 0 auto; width: 2rem; height: 2rem; color: var(--ext-brand-secondary)" />
      <p class="ext-header-banner__title" style="margin-top: 0.5rem">Identity Request</p>
      <p class="ext-header-banner__subtitle">A site wants to verify your identity</p>
    </div>

    <!-- Origin -->
    <div class="ext-card">
      <p class="ext-detail__label">Requesting site</p>
      <p class="ext-detail__value" style="font-family: monospace; margin-top: 0.25rem">{{ origin || 'Unknown' }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="ext-card" style="padding: 1.5rem; text-align: center">
      <p style="font-size: var(--ext-text-xs); color: var(--ext-text-secondary)">Loading wallet...</p>
    </div>

    <!-- Wallet locked / no DID -->
    <template v-else-if="!wallet.isUnlocked || !wallet.did">
      <div class="ext-info-box ext-info-box--warning" style="text-align: center; padding: 1rem; display: flex; flex-direction: column; align-items: center; gap: 0.75rem">
        <component
          :is="!wallet.isUnlocked ? LockClosedIcon : KeyIcon"
          style="width: 1.5rem; height: 1.5rem"
        />
        <p style="font-size: var(--ext-text-xs)">
          {{ !wallet.isUnlocked ? 'Wallet is locked' : 'No DID created yet' }}
        </p>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem">
        <button
          v-if="!wallet.isUnlocked"
          class="ext-btn ext-btn--primary ext-btn--md"
          @click="wallet.unlock()"
        >
          Unlock
        </button>
        <button
          v-if="wallet.isUnlocked && !wallet.did"
          class="ext-btn ext-btn--primary ext-btn--md"
          @click="createDidAndRetry()"
        >
          Create DID
        </button>
        <button class="ext-btn ext-btn--ghost ext-btn--md" @click="deny">
          Cancel
        </button>
      </div>
    </template>

    <!-- Ready to approve -->
    <template v-else>
      <!-- Identity to share -->
      <div class="ext-header-banner ext-header-banner--pay" style="display: flex; flex-direction: column; gap: 0.5rem">
        <p class="ext-detail__label">Share this identity</p>
        <div
          v-for="d in availableDids"
          :key="d.did"
          class="ext-card"
          :style="selectedDid === d.did
            ? { borderColor: 'var(--ext-success-solid)', background: 'rgba(6, 78, 59, 0.3)' }
            : { cursor: 'pointer' }"
          style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem"
          @click="selectedDid = d.did"
        >
          <FingerPrintIcon style="width: 1rem; height: 1rem; color: var(--ext-success); flex-shrink: 0" />
          <div style="flex: 1; min-width: 0">
            <p style="font-size: var(--ext-text-xs); font-weight: 500; color: var(--ext-text-primary)">{{ d.label }}</p>
            <p style="font-size: var(--ext-text-2xs); font-family: monospace; color: var(--ext-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ d.did }}</p>
          </div>
          <span class="ext-badge ext-badge--muted">{{ d.method }}</span>
        </div>
      </div>

      <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-muted); text-align: center; line-height: 1.5">
        Your DID will be shared with <strong style="color: var(--ext-text-secondary)">{{ origin }}</strong> for identity attribution.
        No private keys are disclosed.
      </p>

      <!-- Error -->
      <div v-if="error" class="ext-info-box ext-info-box--error">{{ error }}</div>

      <!-- Action buttons -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem">
        <button class="ext-btn ext-btn--ghost ext-btn--md" @click="deny">
          <XMarkIcon style="width: 1rem; height: 1rem" />
          Deny
        </button>
        <button
          class="ext-btn ext-btn--primary ext-btn--md"
          :disabled="approving || !selectedDid"
          @click="approve"
        >
          <ShieldCheckIcon style="width: 1rem; height: 1rem" />
          {{ approving ? 'Approving...' : 'Approve' }}
        </button>
      </div>
    </template>
  </div>
</template>
