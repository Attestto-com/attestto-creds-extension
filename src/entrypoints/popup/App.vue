<script setup lang="ts">
import { onMounted } from 'vue'
import { useWalletStore } from '@/stores/wallet'
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
import BottomTabBar from '@/components/layout/BottomTabBar.vue'

const wallet = useWalletStore()

onMounted(async () => {
  // Load public data immediately — no passkey needed.
  await wallet.loadPublicData()
  await wallet.checkSetup()
})

function handleLock(): void {
  wallet.lock()
}
</script>

<template>
  <!--
    Mobile-app shell (ATT-1006): brand header (with settings gear), scrolling
    content, and a persistent bottom tab bar.

    Per ATT-724 the popup no longer gates on wallet setup — anti-phishing is
    always visible and identity setup is an optional upgrade inside the tabs.
    Vault unlock happens per-operation (sign / present), not from an idle
    button, and auto-locks after 1 minute.
  -->
  <div class="flex h-full flex-col bg-gradient-to-br from-[#0a0f18] via-[#0f1a2b] to-[#151832] text-white">
    <ExtensionHeader :is-unlocked="wallet.isUnlocked" @lock="handleLock" />

    <main class="min-h-0 flex-1 overflow-y-auto p-3">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <BottomTabBar />
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
