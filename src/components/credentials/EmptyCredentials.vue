<script setup lang="ts">
import { ShieldCheckIcon } from '@heroicons/vue/24/outline'
</script>

<template>
  <div class="flex flex-col items-center justify-center py-10 px-4 text-center">
    <div class="rounded-full bg-slate-800 p-3 mb-3">
      <ShieldCheckIcon class="h-8 w-8 text-indigo-400" />
    </div>
    <h3 class="text-sm font-semibold text-white mb-1">
      No Credentials Yet
    </h3>
    <p class="text-xs text-slate-400 max-w-[260px]">
      Verifiable credentials issued to your wallet will appear here.
      They can be shared with verifiers using selective disclosure.
    </p>
  </div>
</template>
