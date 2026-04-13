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
    class="ext-card ext-card--hover"
    style="width: 100%; display: flex; align-items: center; gap: 0.75rem; text-align: left; cursor: pointer"
    @click="openExplorer(token.mint)"
  >
    <div style="min-width: 0; flex: 1">
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <p style="font-size: var(--ext-text-xs); font-weight: 500; color: var(--ext-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          {{ token.symbol !== 'Unknown' ? token.symbol : token.name }}
        </p>
        <span
          class="ext-badge"
          :class="token.isToken2022 ? 'ext-badge--brand' : 'ext-badge--info'"
          style="font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em"
        >
          {{ token.isToken2022 ? 'Token-2022' : 'SPL' }}
        </span>
      </div>
      <p style="margin-top: 0.125rem; font-size: var(--ext-text-2xs); color: var(--ext-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
        {{ token.name }}
      </p>
    </div>
    <div style="text-align: right; flex-shrink: 0">
      <p style="font-size: var(--ext-text-xs); font-weight: 600; color: var(--ext-text-primary)">{{ token.balance }}</p>
    </div>
  </button>
</template>
