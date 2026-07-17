<script setup lang="ts">
import { ref, computed } from 'vue'
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

/**
 * Carnet background. Each credential gets a deterministic gradient (recognizable
 * at a glance) derived from its type + issuer. An issuer may override it via a
 * `background` claim — validated against a safe allowlist (hex colour or a
 * linear-gradient) so a site can theme its own card without injecting CSS.
 * Skins/artwork come later; this is the simple hook.
 */
const SAFE_BG = /^(#[0-9a-fA-F]{3,8}|linear-gradient\([^;{}]+\))$/

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

const cardBackground = computed<string>(() => {
  const issuerBg = (props.credential.decodedClaims as Record<string, unknown>).background
  if (typeof issuerBg === 'string' && SAFE_BG.test(issuerBg.trim())) return issuerBg.trim()
  const h = hashHue(`${props.credential.types.join()}|${props.credential.issuer}`)
  return `linear-gradient(135deg, hsl(${h} 68% 44%), hsl(${(h + 42) % 360} 68% 34%))`
})

function openMintExplorer(): void {
  if (mintAddress) {
    window.open(`https://explorer.solana.com/address/${mintAddress}?cluster=devnet`, '_blank')
  }
}
</script>

<template>
  <div class="rounded-xl overflow-hidden shadow-sm ring-1 ring-white/10">
    <!-- Carnet band — deterministic (or issuer-supplied) background -->
    <button
      class="w-full p-3 text-left text-white transition-opacity hover:opacity-95"
      :style="{ background: cardBackground }"
      @click="expanded = !expanded"
    >
      <div class="flex items-center gap-2">
        <!-- Format pill -->
        <span
          class="shrink-0 rounded-full bg-black/25 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/90"
        >
          {{ credential.format === 'sd-jwt' ? 'SD-JWT' : 'JSON-LD' }}
        </span>

        <!-- On-chain badge -->
        <button
          v-if="mintAddress"
          class="shrink-0 rounded-full bg-black/25 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/90 hover:bg-black/40 transition-colors"
          @click.stop="openMintExplorer"
        >
          On-Chain
        </button>

        <component
          :is="expanded ? ChevronUpIcon : ChevronDownIcon"
          class="ml-auto h-4 w-4 text-white/70 shrink-0"
        />
      </div>

      <p class="mt-3 text-sm font-semibold text-white truncate drop-shadow-sm">
        {{ credential.types[credential.types.length - 1] ?? 'Credential' }}
      </p>
      <p class="text-[10px] text-white/75 truncate">
        {{ credential.issuer }}
      </p>
    </button>

    <!-- Expanded content -->
    <div v-if="expanded" class="bg-slate-900 p-3 space-y-3">
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
