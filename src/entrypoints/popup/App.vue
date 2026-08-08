<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useWalletStore } from '@/stores/wallet'
import { startActivityReporter } from '@/composables/useActivityReporter'
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
import BottomTabBar from '@/components/layout/BottomTabBar.vue'

const wallet = useWalletStore()
let stopActivityReporter: (() => void) | null = null

onMounted(async () => {
  // Story 1.14 — the idle lock is measured from real user activity, and the
  // worker cannot see the popup. Using the wallet has to say so out loud.
  stopActivityReporter = startActivityReporter()
  // Load public data immediately — no passkey needed.
  await wallet.loadPublicData()
  await wallet.checkSetup()
})

onUnmounted(() => stopActivityReporter?.())

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
    button, and auto-locks after an idle timeout the user sets in Settings.
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
