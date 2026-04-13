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
  <div class="ext-card" style="overflow: hidden; padding: 0">
    <!-- Header -->
    <button
      style="width: 100%; display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem; text-align: left; cursor: pointer; background: none; border: none; transition: background 0.15s"
      @click="expanded = !expanded"
    >
      <!-- Format pill -->
      <span
        class="ext-badge"
        :class="credential.format === 'sd-jwt' ? 'ext-badge--brand' : 'ext-badge--success'"
        style="font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0"
      >
        {{ credential.format === 'sd-jwt' ? 'SD-JWT' : 'JSON-LD' }}
      </span>

      <!-- On-chain badge -->
      <button
        v-if="mintAddress"
        class="ext-badge ext-badge--brand"
        style="font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; cursor: pointer; border: none"
        @click.stop="openMintExplorer"
      >
        On-Chain
      </button>

      <div style="min-width: 0; flex: 1">
        <p style="font-size: var(--ext-text-xs); font-weight: 500; color: var(--ext-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          {{ credential.types[credential.types.length - 1] ?? 'Credential' }}
        </p>
        <p style="font-size: var(--ext-text-2xs); color: var(--ext-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
          {{ credential.issuer }}
        </p>
      </div>

      <component
        :is="expanded ? ChevronUpIcon : ChevronDownIcon"
        style="width: 1rem; height: 1rem; color: var(--ext-text-muted); flex-shrink: 0"
      />
    </button>

    <!-- Expanded content -->
    <div v-if="expanded" style="border-top: 1px solid var(--ext-border); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.75rem">
      <!-- Dates -->
      <div style="display: flex; gap: 1rem; font-size: var(--ext-text-2xs); color: var(--ext-text-secondary)">
        <span>Issued: {{ formatDate(credential.issuedAt) }}</span>
        <span v-if="credential.expiresAt">
          Expires: {{ formatDate(credential.expiresAt) }}
        </span>
      </div>

      <!-- Claims -->
      <div>
        <p class="ext-detail__label">
          {{ claimCount }} claim{{ claimCount !== 1 ? 's' : '' }}
        </p>
        <CredentialClaimList :claims="credential.decodedClaims" />
      </div>

      <!-- Actions -->
      <div style="display: flex; gap: 0.5rem; padding-top: 0.25rem">
        <button
          class="ext-btn ext-btn--primary ext-btn--sm"
          style="flex: 1"
          @click.stop="emit('share', credential.id)"
        >
          <ShareIcon style="width: 0.875rem; height: 0.875rem" />
          Share
        </button>
        <button
          class="ext-btn ext-btn--danger ext-btn--sm"
          @click.stop="emit('delete', credential.id)"
        >
          <TrashIcon style="width: 0.875rem; height: 0.875rem" />
        </button>
      </div>
    </div>
  </div>
</template>
