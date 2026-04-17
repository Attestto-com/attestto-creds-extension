<script setup lang="ts">
import { computed } from 'vue'
import {
  LockClosedIcon,
  LockOpenIcon,
} from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'

const wallet = useWalletStore()

const statusLabel = computed(() =>
  wallet.isUnlocked ? 'Wallet Unlocked' : 'Wallet Locked',
)

/** Human-readable identity label — never show raw did:jwk blobs to users */
const identityLabel = computed(() => {
  if (!wallet.did) return null
  // did:web:eduardo.attestto.id → eduardo.attestto.id
  if (wallet.did.startsWith('did:web:'))
    return wallet.did.slice(8).replace(/:/g, '/')
  // did:sns:name.attestto.sol → name.attestto.sol
  if (wallet.did.startsWith('did:sns:'))
    return wallet.did.slice(8)
  // did:jwk:... → "Local key" (the base64 is useless to humans)
  if (wallet.did.startsWith('did:jwk:'))
    return 'Local key (not yet linked)'
  // did:pkh:solana:... → shortened address
  if (wallet.did.startsWith('did:pkh:solana:')) {
    const addr = wallet.did.slice(14)
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`
  }
  // Fallback: truncate
  return `${wallet.did.slice(0, 24)}…`
})

const identityMethod = computed(() => {
  if (!wallet.did) return ''
  const parts = wallet.did.split(':')
  return parts.length >= 2 ? parts.slice(0, 2).join(':') : ''
})


</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <!-- Status Card -->
    <div
      class="ext-card"
      :style="wallet.isUnlocked
        ? { borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(6, 78, 59, 0.3)' }
        : {}"
      style="padding: 1rem"
    >
      <div style="display: flex; align-items: center; gap: 0.75rem">
        <component
          :is="wallet.isUnlocked ? LockOpenIcon : LockClosedIcon"
          style="width: 1.5rem; height: 1.5rem"
          :style="{ color: wallet.isUnlocked ? 'var(--ext-success)' : 'var(--ext-text-muted)' }"
        />
        <div>
          <p style="font-size: var(--ext-text-md); font-weight: 600; color: var(--ext-text-primary)">{{ statusLabel }}</p>
          <p v-if="wallet.did" style="margin-top: 0.125rem; font-size: var(--ext-text-xs); color: var(--ext-text-secondary); display: flex; align-items: center; gap: 0.375rem">
            <span>{{ identityLabel }}</span>
            <span style="font-size: var(--ext-text-2xs); color: var(--ext-text-muted); background: var(--ext-bg-surface-hover); padding: 0.0625rem 0.375rem; border-radius: var(--ext-radius-sm)">{{ identityMethod }}</span>
          </p>
          <p v-else style="margin-top: 0.125rem; font-size: var(--ext-text-xs); color: var(--ext-text-muted)">
            No DID created yet
          </p>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem">
      <button v-if="!wallet.isUnlocked" class="ext-btn ext-btn--primary ext-btn--md" @click="wallet.unlock()">
        Unlock Wallet
      </button>
      <button v-if="!wallet.did" class="ext-btn ext-btn--ghost ext-btn--md" @click="wallet.createDid()">
        Create DID
      </button>
      <button v-if="wallet.isUnlocked" class="ext-btn ext-btn--ghost ext-btn--md" @click="wallet.lock()">
        Lock
      </button>
    </div>

  </div>
</template>
