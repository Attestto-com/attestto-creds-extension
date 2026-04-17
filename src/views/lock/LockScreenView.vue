<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { FingerPrintIcon } from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import { APP_NAME } from '@/config/app'

const wallet = useWalletStore()
const loading = ref(true)
const acting = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  await wallet.checkSetup()
  loading.value = false
})

async function handleAction(): Promise<void> {
  acting.value = true
  error.value = null

  try {
    if (wallet.isSetUp) {
      await wallet.unlock()
    } else {
      await wallet.setup()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Authentication failed'
  } finally {
    acting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-[400px] flex-col items-center justify-center px-6">
    <!-- Logo area -->
    <div class="mb-8 text-center">
      <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600/20">
        <FingerPrintIcon class="h-9 w-9 text-indigo-400" />
      </div>
      <h1 class="text-lg font-bold text-white">{{ APP_NAME }}</h1>
      <p class="mt-1 text-[11px] text-slate-500">Your self-sovereign identity</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-xs text-slate-500">Loading...</div>

    <!-- Action button -->
    <template v-else>
      <button
        class="w-full max-w-[220px] rounded-xl bg-indigo-600 px-6 py-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        :disabled="acting"
        @click="handleAction"
      >
        <template v-if="acting">
          {{ wallet.isSetUp ? 'Unlocking...' : 'Setting up...' }}
        </template>
        <template v-else>
          {{ wallet.isSetUp ? 'Unlock with Passkey' : 'Set Up Passkey' }}
        </template>
      </button>

      <p v-if="!wallet.isSetUp" class="mt-3 text-[10px] text-slate-500 text-center max-w-[220px]">
        Your vault will be secured with your device's biometric or PIN
      </p>

      <!-- Error -->
      <p v-if="error" class="mt-3 text-[11px] text-red-400 text-center max-w-[250px]">
        {{ error }}
      </p>
    </template>

    <!-- Version -->
    <p class="mt-8 text-[9px] text-slate-700">v0.1.0</p>
  </div>
</template>
