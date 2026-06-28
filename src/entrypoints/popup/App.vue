<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
import LockScreenView from '@/views/lock/LockScreenView.vue'

const router = useRouter()
const wallet = useWalletStore()
const unlockError = ref<string | null>(null)
// Forces LockScreenView even when the vault is set up — used when the
// inline-unlock path hits a recoverable error (passphrase needed, reset needed)
// so the user gets the full recovery UI instead of just a red banner.
const showLockView = ref(false)

onMounted(async () => {
  // Load public data immediately — no passkey needed
  await wallet.loadPublicData()
  await wallet.checkSetup()
})

// When unlock succeeds (via LockScreenView or otherwise), drop back to the
// normal identity view.
watch(
  () => wallet.isUnlocked,
  (unlocked) => {
    if (unlocked) {
      showLockView.value = false
      unlockError.value = null
    }
  },
)

function handleLock(): void {
  wallet.lock()
}

async function handleUnlock(): Promise<void> {
  unlockError.value = null
  try {
    await wallet.unlock()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unlock failed'
    // Recovery paths (passphrase prompt, vault reset) live in LockScreenView.
    // Route there instead of leaving the user staring at a dead red banner.
    if (msg.startsWith('PASSPHRASE_REQUIRED') || msg.startsWith('PRF_UNAVAILABLE')) {
      showLockView.value = true
    } else {
      unlockError.value = msg
    }
  }
}

function handleSettings(): void {
  router.push({ name: 'settings' })
}
</script>

<template>
  <div class="flex min-h-[200px] flex-col bg-slate-950 text-white">
    <!-- First-time setup OR recovery flow (passphrase prompt / reset on PRF failure) -->
    <LockScreenView v-if="!wallet.isSetUp || showLockView" />

    <!-- Normal state — always show credentials -->
    <template v-else>
      <ExtensionHeader
        :is-unlocked="wallet.isUnlocked"
        @lock="handleLock"
        @unlock="handleUnlock"
        @settings="handleSettings"
      />
      <p
        v-if="unlockError"
        class="px-3 py-1.5 text-[11px] text-red-400 bg-red-950/40 border-b border-red-900/40"
      >
        {{ unlockError }}
      </p>
      <main class="flex-1 overflow-y-auto p-3">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </template>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
