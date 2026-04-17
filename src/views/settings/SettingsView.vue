<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  GlobeAltIcon,
  ClockIcon,
  QuestionMarkCircleIcon,
  ArrowTopRightOnSquareIcon,
  InformationCircleIcon,
  ArrowLeftIcon,
} from '@heroicons/vue/24/outline'
import { useRouter } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import { APP_VERSION, STORAGE_KEYS } from '@/config/app'

const router = useRouter()
const wallet = useWalletStore()

const AUTO_LOCK_KEY = 'attestto_ext_auto_lock_minutes'
const AUTO_LOCK_OPTIONS = [1, 5, 10, 30, 60]

const autoLockMinutes = ref(5)

onMounted(async () => {
  const stored = await chrome.storage.local.get(AUTO_LOCK_KEY)
  if (stored[AUTO_LOCK_KEY]) {
    autoLockMinutes.value = Number(stored[AUTO_LOCK_KEY])
  }
})

async function setAutoLock(minutes: number): Promise<void> {
  autoLockMinutes.value = minutes
  await chrome.storage.local.set({ [AUTO_LOCK_KEY]: minutes })
  // Notify background to update the timer
  chrome.runtime.sendMessage({ type: 'AUTO_LOCK_CHANGED', minutes }).catch(() => {})
}

/** Derive connected platforms from linked identities */
const connectedPlatforms = computed(() => {
  const seen = new Map<string, { origin: string; label: string; count: number }>()

  for (const identity of wallet.linkedIdentities) {
    // Extract platform from DID or tenantId
    const snsMatch = identity.did.match(/^did:sns:[\w-]+\.([\w-]+)\.sol$/)
    const origin = snsMatch ? `${snsMatch[1]}.sol` : (identity.tenantId ?? 'attestto.net')
    const label = snsMatch ? snsMatch[1] : (identity.tenantId ?? 'Attestto')

    if (seen.has(origin)) {
      seen.get(origin)!.count++
    } else {
      seen.set(origin, { origin, label, count: 1 })
    }
  }

  // Always show Attestto as connected if vault is set up
  if (seen.size === 0 && wallet.isSetUp) {
    seen.set('attestto.net', { origin: 'attestto.net', label: 'Attestto', count: 0 })
  }

  return [...seen.values()]
})

function goBack(): void {
  router.push({ name: 'home' })
}

function openDashboard(): void {
  window.open('https://attestto.net', '_blank')
}

function openHelp(): void {
  window.open('https://docs.attestto.com', '_blank')
}
</script>

<template>
  <div class="space-y-3">
    <button
      class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
      @click="goBack"
    >
      <ArrowLeftIcon class="h-3.5 w-3.5" />
      Back
    </button>

    <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
      Settings
    </p>

    <!-- Connected Platforms -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <div class="flex items-center gap-2 mb-2">
        <GlobeAltIcon class="h-4 w-4 text-slate-400" />
        <p class="text-xs font-medium text-white">Connected Platforms</p>
      </div>
      <div v-if="connectedPlatforms.length === 0" class="text-[11px] text-slate-500">
        No connected platforms yet
      </div>
      <div
        v-for="platform in connectedPlatforms"
        :key="platform.origin"
        class="flex items-center gap-2 rounded-md bg-slate-800/50 px-2 py-1.5"
      >
        <span class="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span class="text-[11px] text-slate-300">{{ platform.label }}</span>
        <span v-if="platform.count > 0" class="text-[10px] text-slate-500">{{ platform.count }} {{ platform.count === 1 ? 'identity' : 'identities' }}</span>
        <span class="ml-auto text-[10px] font-mono text-slate-500">{{ platform.origin }}</span>
      </div>
    </div>

    <!-- Auto-lock -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <div class="flex items-center gap-2 mb-2">
        <ClockIcon class="h-4 w-4 text-slate-400" />
        <p class="text-xs font-medium text-white">Auto-lock</p>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="opt in AUTO_LOCK_OPTIONS"
          :key="opt"
          class="rounded-md px-2 py-1 text-[11px] transition-colors"
          :class="autoLockMinutes === opt
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-800 text-slate-400 hover:bg-slate-700'"
          @click="setAutoLock(opt)"
        >
          {{ opt }}m
        </button>
      </div>
    </div>

    <!-- Help -->
    <button
      class="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left hover:bg-slate-800 transition-colors"
      @click="openHelp"
    >
      <QuestionMarkCircleIcon class="h-4 w-4 text-slate-400" />
      <span class="text-xs text-white">Help</span>
      <ArrowTopRightOnSquareIcon class="ml-auto h-3.5 w-3.5 text-slate-600" />
    </button>

    <!-- Go to Dashboard -->
    <button
      class="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left hover:bg-slate-800 transition-colors"
      @click="openDashboard"
    >
      <ArrowTopRightOnSquareIcon class="h-4 w-4 text-slate-400" />
      <span class="text-xs text-white">Go to Dashboard</span>
    </button>

    <!-- About -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <div class="flex items-center gap-2">
        <InformationCircleIcon class="h-4 w-4 text-slate-400" />
        <p class="text-xs font-medium text-white">About</p>
        <span class="ml-auto text-[11px] text-slate-500">v{{ APP_VERSION }}</span>
      </div>
    </div>
  </div>
</template>
