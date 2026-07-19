<script setup lang="ts">
/**
 * Popup title bar.
 *
 * Shows the Attestto brand lockup (logo badge first, then the wordmark),
 * left-aligned, in BOTH full mode and minimal (setup / recovery) mode. The
 * active site's identity + trust now live entirely in SiteIdentityCard, not
 * here.
 *
 * Right side: an X that closes the popup window. The vault auto-locks after
 * 1 minute and unlocks on demand, so there is no manual lock/unlock button.
 */
import { Cog6ToothIcon, XMarkIcon } from '@heroicons/vue/24/outline'

withDefaults(defineProps<{
  isUnlocked: boolean
  // Kept for API compatibility with the LockScreenView call site; the header
  // now renders the same brand lockup regardless.
  minimal?: boolean
}>(), {
  minimal: false,
})

defineEmits<{
  lock: []
}>()

function openSettings(): void {
  chrome.runtime.openOptionsPage()
}

function closeWindow(): void {
  window.close()
}
</script>

<template>
  <header class="border-b border-slate-800/40 bg-transparent px-3 py-2.5">
    <div class="flex items-center justify-between gap-2">
      <!-- Brand lockup: logo badge first (always), then the wordmark, then a
           settings gear. Left-aligned. -->
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded-md bg-slate-700 text-[11px] font-bold lowercase leading-none text-white"
          aria-hidden="true"
        >tt</span>
        <span class="truncate text-sm font-bold lowercase tracking-tight text-white">attestto</span>
        <button
          v-if="!minimal"
          type="button"
          class="shrink-0 rounded-md p-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          title="Settings"
          @click="openSettings"
        >
          <Cog6ToothIcon class="h-5 w-5" />
        </button>
      </div>

      <button
        type="button"
        class="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
        title="Close"
        @click="closeWindow"
      >
        <XMarkIcon class="h-5 w-5" />
      </button>
    </div>
  </header>
</template>
