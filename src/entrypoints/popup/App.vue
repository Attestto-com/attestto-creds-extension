<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
import LockScreenView from '@/views/lock/LockScreenView.vue'

const router = useRouter()
const wallet = useWalletStore()

onMounted(async () => {
  // Load public data immediately — no passkey needed
  await wallet.loadPublicData()
  await wallet.checkSetup()
})

function handleLock(): void {
  wallet.lock()
}

function handleSettings(): void {
  router.push({ name: 'settings' })
}
</script>

<template>
  <div class="flex min-h-[200px] flex-col bg-slate-950 text-white">
    <!-- First-time setup — no passkey registered yet -->
    <LockScreenView v-if="!wallet.isSetUp" />

    <!-- Normal state — always show credentials -->
    <template v-else>
      <ExtensionHeader @lock="handleLock" @settings="handleSettings" />
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
