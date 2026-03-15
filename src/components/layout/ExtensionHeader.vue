<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'
import { ShieldCheckIcon, KeyIcon, Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { APP_NAME } from '@/config/app'

const router = useRouter()
const route = useRoute()

const tabs = [
  { name: 'wallet', icon: KeyIcon, label: 'Wallet' },
  { name: 'credentials', icon: ShieldCheckIcon, label: 'Credentials' },
  { name: 'settings', icon: Cog6ToothIcon, label: 'Settings' },
] as const

function navigate(name: string): void {
  router.push({ name })
}
</script>

<template>
  <header class="border-b border-slate-800 bg-slate-950 px-3 pt-3 pb-0">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-sm font-bold tracking-wide text-white">{{ APP_NAME }}</span>
      <span class="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
        MV3
      </span>
    </div>

    <nav class="flex gap-1">
      <button
        v-for="tab in tabs"
        :key="tab.name"
        class="flex flex-1 flex-col items-center gap-0.5 rounded-t-lg px-2 py-1.5 text-[10px] transition-colors"
        :class="route.name === tab.name
          ? 'bg-slate-800 text-white'
          : 'text-slate-500 hover:text-slate-300'"
        @click="navigate(tab.name)"
      >
        <component :is="tab.icon" class="h-4 w-4" />
        {{ tab.label }}
      </button>
    </nav>
  </header>
</template>
