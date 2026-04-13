<script setup lang="ts">
import { Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { APP_VERSION } from '@/config/app'

function openOptionsPage(): void {
  chrome.runtime.openOptionsPage()
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div class="ext-card" style="padding: 1rem">
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <Cog6ToothIcon style="width: 1.25rem; height: 1.25rem; color: var(--ext-text-secondary)" />
        <h2 style="font-size: var(--ext-text-md); font-weight: 600; color: var(--ext-text-primary)">Quick Settings</h2>
      </div>
    </div>

    <button
      class="ext-btn ext-btn--ghost ext-btn--md"
      style="width: 100%; justify-content: flex-start"
      @click="openOptionsPage"
    >
      Open Full Settings Page
    </button>

    <p style="text-align: center; font-size: var(--ext-text-2xs); color: var(--ext-text-dim)">
      v{{ APP_VERSION }}
    </p>
  </div>
</template>
