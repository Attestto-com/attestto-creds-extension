<script setup lang="ts">
import { LockClosedIcon, FingerPrintIcon, Cog6ToothIcon } from '@heroicons/vue/24/outline'
import { APP_NAME } from '@/config/app'

withDefaults(defineProps<{
  isUnlocked: boolean
  // Hide all action buttons. Used by LockScreenView during first-time setup
  // and recovery flows where settings/lock/unlock have no useful target.
  minimal?: boolean
}>(), {
  minimal: false,
})

defineEmits<{
  lock: []
  unlock: []
  settings: []
}>()
</script>

<template>
  <header class="border-b border-slate-800 bg-slate-950 px-3 py-2.5">
    <div class="flex items-center justify-between">
      <span class="text-sm font-bold tracking-wide text-white">{{ APP_NAME }}</span>
      <div v-if="!minimal" class="flex items-center gap-1.5">
        <button
          class="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          title="Settings"
          @click="$emit('settings')"
        >
          <Cog6ToothIcon class="h-4 w-4" />
        </button>
        <button
          v-if="isUnlocked"
          class="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
          title="Lock"
          @click="$emit('lock')"
        >
          <LockClosedIcon class="h-4 w-4" />
        </button>
        <button
          v-else
          class="rounded-md p-1 text-indigo-400 hover:bg-slate-800 hover:text-indigo-300"
          title="Unlock with passkey"
          @click="$emit('unlock')"
        >
          <FingerPrintIcon class="h-4 w-4" />
        </button>
      </div>
    </div>
  </header>
</template>
