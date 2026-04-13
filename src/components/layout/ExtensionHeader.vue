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
  <header style="border-bottom: 1px solid var(--ext-border); background: var(--ext-bg-page); padding: 0.75rem 0.75rem 0">
    <div style="margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between">
      <span style="font-size: var(--ext-text-md); font-weight: 700; letter-spacing: 0.025em; color: var(--ext-text-primary)">{{ APP_NAME }}</span>
      <span class="ext-badge ext-badge--success">MV3</span>
    </div>

    <nav style="display: flex; gap: 0.25rem">
      <button
        v-for="tab in tabs"
        :key="tab.name"
        style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 0.125rem; padding: 0.375rem 0.5rem; border-radius: var(--ext-radius-md) var(--ext-radius-md) 0 0; font-size: var(--ext-text-2xs); transition: color 0.15s, background 0.15s; cursor: pointer; border: none"
        :style="route.name === tab.name
          ? { background: 'var(--ext-bg-surface-hover)', color: 'var(--ext-text-primary)' }
          : { background: 'transparent', color: 'var(--ext-text-muted)' }"
        @click="navigate(tab.name)"
      >
        <component :is="tab.icon" style="width: 1rem; height: 1rem" />
        {{ tab.label }}
      </button>
    </nav>
  </header>
</template>
