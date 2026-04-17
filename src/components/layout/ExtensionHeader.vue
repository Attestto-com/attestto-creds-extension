<script setup lang="ts">
import { LockClosedIcon, Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { APP_NAME } from '@/config/app'

defineEmits<{
  lock: []
  settings: []
}>()
</script>

<template>
  <header class="border-b border-slate-800 bg-slate-950 px-3 py-2.5">
    <div class="flex items-center justify-between">
      <span class="text-sm font-bold tracking-wide text-white">{{ APP_NAME }}</span>
      <div class="flex items-center gap-1.5">
        <button
          class="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          title="Settings"
          @click="$emit('settings')"
        >
          <Cog6ToothIcon class="h-4 w-4" />
        </button>
        <button
          class="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          title="Lock"
          @click="$emit('lock')"
        >
          <LockClosedIcon class="h-4 w-4" />
        </button>
      </div>
    </div>
  </header>
</template>
