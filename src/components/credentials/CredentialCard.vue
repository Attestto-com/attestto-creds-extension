<script setup lang="ts">
import { ref } from 'vue'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ShareIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import type { StoredCredential } from '@/types/credential'
import CredentialClaimList from './CredentialClaimList.vue'

const props = defineProps<{
  credential: StoredCredential
}>()

const emit = defineEmits<{
  share: [id: string]
  delete: [id: string]
}>()

const expanded = ref(false)

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const claimCount = Object.keys(props.credential.decodedClaims).length

const mintAddress = (props.credential.decodedClaims as Record<string, unknown>).mintAddress as string | undefined

function openMintExplorer(): void {
  if (mintAddress) {
    window.open(`https://explorer.solana.com/address/${mintAddress}?cluster=devnet`, '_blank')
  }
}
</script>

<template>
  <div class="rounded-lg border border-slate-700 bg-slate-900 overflow-hidden">
    <!-- Header -->
    <button
      class="w-full flex items-center gap-2 p-3 text-left hover:bg-slate-800/50 transition-colors"
      @click="expanded = !expanded"
    >
      <!-- Format pill -->
      <span
        class="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
        :class="credential.format === 'sd-jwt'
          ? 'bg-indigo-500/20 text-indigo-300'
          : 'bg-emerald-500/20 text-emerald-300'"
      >
        {{ credential.format === 'sd-jwt' ? 'SD-JWT' : 'JSON-LD' }}
      </span>

      <!-- On-chain badge -->
      <button
        v-if="mintAddress"
        class="shrink-0 rounded-full bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-purple-300 hover:bg-purple-500/30 transition-colors"
        @click.stop="openMintExplorer"
      >
        On-Chain
      </button>

      <div class="min-w-0 flex-1">
        <p class="text-xs font-medium text-white truncate">
          {{ credential.types[credential.types.length - 1] ?? 'Credential' }}
        </p>
        <p class="text-[10px] text-slate-400 truncate">
          {{ credential.issuer }}
        </p>
      </div>

      <component
        :is="expanded ? ChevronUpIcon : ChevronDownIcon"
        class="h-4 w-4 text-slate-500 shrink-0"
      />
    </button>

    <!-- Expanded content -->
    <div v-if="expanded" class="border-t border-slate-800 p-3 space-y-3">
      <!-- Dates -->
      <div class="flex gap-4 text-[10px] text-slate-400">
        <span>Issued: {{ formatDate(credential.issuedAt) }}</span>
        <span v-if="credential.expiresAt">
          Expires: {{ formatDate(credential.expiresAt) }}
        </span>
      </div>

      <!-- Claims -->
      <div>
        <p class="text-[10px] font-medium text-slate-400 mb-1">
          {{ claimCount }} claim{{ claimCount !== 1 ? 's' : '' }}
        </p>
        <CredentialClaimList :claims="credential.decodedClaims" />
      </div>

      <!-- Actions -->
      <div class="flex gap-2 pt-1">
        <button
          class="flex-1 flex items-center justify-center gap-1 rounded-md bg-indigo-600 px-2 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 transition-colors"
          @click.stop="emit('share', credential.id)"
        >
          <ShareIcon class="h-3.5 w-3.5" />
          Share
        </button>
        <button
          class="flex items-center justify-center gap-1 rounded-md bg-slate-800 px-2 py-1.5 text-[11px] font-medium text-red-400 hover:bg-red-900/30 transition-colors"
          @click.stop="emit('delete', credential.id)"
        >
          <TrashIcon class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
