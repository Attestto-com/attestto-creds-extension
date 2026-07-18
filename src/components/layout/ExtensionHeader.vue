<script setup lang="ts">
/**
 * Popup title bar (ATT-1006).
 *
 * Full mode shows the ACTIVE SITE'S status (domain + a trust dot) — the brand
 * moves to the footer. Minimal mode (setup / recovery in LockScreenView) has
 * no active site, so it falls back to the app name.
 *
 * There is no gear here anymore: settings live on a full page reached from the
 * footer. And there is no manual "unlock" button — the vault unlocks on demand
 * when an action needs the key and auto-locks after 1 minute.
 */
import { computed, onMounted, ref } from 'vue'
import { LockClosedIcon } from '@heroicons/vue/24/outline'
import { APP_NAME } from '@/config/app'
import { computeStateForUrl, type TrustState } from '@/utils/tab-state'
import CrFlag from '@/components/layout/CrFlag.vue'

withDefaults(defineProps<{
  isUnlocked: boolean
  // Hide the site status + action buttons. Used by LockScreenView during
  // first-time setup and recovery flows where there is no active site.
  minimal?: boolean
}>(), {
  minimal: false,
})

defineEmits<{
  lock: []
}>()

const host = ref<string | null>(null)
const trustState = ref<TrustState>('neutral')

/** Costa Rican host → show the CR flag chip in the title bar. */
const isCostaRican = computed(() => /\.cr$/.test(host.value ?? ''))

/** Trust state → status-dot color. Mirrors STATE_VISUALS families. */
const DOT_CLASS: Record<TrustState, string> = {
  neutral: 'bg-slate-500',
  'green-pinned': 'bg-emerald-400',
  'green-verified': 'bg-emerald-400',
  'yellow-heuristic': 'bg-amber-400',
  'yellow-cert': 'bg-amber-400',
  red: 'bg-red-500',
}

onMounted(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? null
    if (!url || !/^https?:/.test(url)) return
    host.value = new URL(url).host.toLowerCase().replace(/^www\./, '')
    trustState.value = await computeStateForUrl(url)
  } catch {
    // No tab access (e.g. detached window) — leave the app-name fallback.
  }
})
</script>

<template>
  <header class="border-b border-slate-800/40 bg-transparent px-3 py-2.5">
    <div class="flex items-center justify-between gap-2">
      <!-- Active-site status chip: CR flag, then domain, then the trust seal. -->
      <div v-if="!minimal && host" class="flex min-w-0 flex-1 items-center gap-2">
        <CrFlag v-if="isCostaRican" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-white">{{ host }}</span>
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="DOT_CLASS[trustState]" />
      </div>
      <span v-else class="text-sm font-bold tracking-wide text-white">{{ APP_NAME }}</span>

      <div v-if="!minimal" class="flex items-center gap-1.5">
        <button
          v-if="isUnlocked"
          class="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          title="Lock"
          @click="$emit('lock')"
        >
          <LockClosedIcon class="h-5 w-5" />
        </button>
      </div>
    </div>
  </header>
</template>
