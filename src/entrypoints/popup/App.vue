<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWalletStore } from '@/stores/wallet'
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
import BottomTabBar from '@/components/layout/BottomTabBar.vue'

const wallet = useWalletStore()
const { t } = useI18n()

onMounted(async () => {
  // Load public data immediately — no passkey needed.
  await wallet.loadPublicData()
  await wallet.checkSetup()
})

function handleLock(): void {
  wallet.lock()
}

/** Full settings live on their own page (options.html), reached from the footer. */
function openSettings(): void {
  chrome.runtime.openOptionsPage()
}
</script>

<template>
  <!--
    Mobile-app shell (ATT-1006): site-status header, scrolling content,
    persistent bottom tab bar, and a small "Powered by Attestto ID" footer
    that is the entry to the full settings page.

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

    <footer
      class="flex items-center justify-center gap-1.5 border-t border-slate-800/40 bg-transparent py-1.5 text-[10px] text-slate-500"
    >
      <button type="button" class="hover:text-slate-300" @click="openSettings">
        {{ t('footer.poweredBy') }}
      </button>
      <span aria-hidden="true">·</span>
      <button type="button" class="hover:text-slate-300" @click="openSettings">
        {{ t('footer.settings') }}
      </button>
    </footer>
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
