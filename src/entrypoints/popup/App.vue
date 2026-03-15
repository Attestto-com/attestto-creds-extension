<script setup lang="ts">
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
</script>

<template>
  <div class="flex min-h-[200px] flex-col bg-slate-950 text-white">
    <ExtensionHeader />
    <main class="flex-1 overflow-y-auto p-3">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
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
