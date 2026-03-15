<script setup lang="ts">
import { Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { APP_VERSION } from '@/config/app'

function openOptionsPage(): void {
  chrome.runtime.openOptionsPage()
}
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div class="flex items-center gap-2">
        <Cog6ToothIcon class="h-5 w-5 text-slate-400" />
        <h2 class="text-sm font-semibold text-white">Quick Settings</h2>
      </div>
    </div>

    <button
      class="w-full rounded-lg border border-slate-700 px-3 py-2 text-left text-xs text-slate-300 hover:bg-slate-800"
      @click="openOptionsPage"
    >
      Open Full Settings Page
    </button>

    <p class="text-center text-[10px] text-slate-600">
      v{{ APP_VERSION }}
    </p>
  </div>
</template>
