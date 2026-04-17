<script setup lang="ts">
import type { LinkedToken } from '@/types/solana'

defineProps<{
  token: LinkedToken
}>()

function openExplorer(mint: string): void {
  window.open(`https://explorer.solana.com/address/${mint}?cluster=devnet`, '_blank')
}
</script>

<template>
  <button
    class="w-full flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3 text-left hover:bg-slate-800 transition-colors"
    @click="openExplorer(token.mint)"
  >
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <p class="text-xs font-medium text-white truncate">
          {{ token.symbol !== 'Unknown' ? token.symbol : token.name }}
        </p>
        <span
          class="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          :class="token.isToken2022
            ? 'bg-purple-500/20 text-purple-300'
            : 'bg-blue-500/20 text-blue-300'"
        >
          {{ token.isToken2022 ? 'Token-2022' : 'SPL' }}
        </span>
      </div>
      <p class="mt-0.5 text-[10px] text-slate-400 truncate">
        {{ token.name }}
      </p>
    </div>
    <div class="text-right shrink-0">
      <p class="text-xs font-semibold text-white">{{ token.balance }}</p>
    </div>
  </button>
</template>
