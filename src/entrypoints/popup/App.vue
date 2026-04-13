<script setup lang="ts">
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
</script>

<template>
  <div style="display: flex; flex-direction: column; min-height: 200px; background: var(--ext-bg-page); color: var(--ext-text-primary)">
    <ExtensionHeader />
    <main style="flex: 1; overflow-y: auto; padding: 0.75rem">
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
