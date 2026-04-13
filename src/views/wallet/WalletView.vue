<script setup lang="ts">
import { computed, toRef } from 'vue'
import {
  LockClosedIcon,
  LockOpenIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  LinkIcon,
} from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import { useSolanaTokens } from '@/composables/useSolanaTokens'
import SolanaTokenCard from '@/components/wallet/SolanaTokenCard.vue'

const wallet = useWalletStore()

const statusLabel = computed(() =>
  wallet.isUnlocked ? 'Wallet Unlocked' : 'Wallet Locked',
)

const { tokens, loading, error: tokenError, refresh } = useSolanaTokens(
  toRef(() => wallet.linkedSolanaAddress),
)

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`
}

function openExplorer(addr: string): void {
  window.open(`https://explorer.solana.com/address/${addr}?cluster=devnet`, '_blank')
}

async function unlinkWallet(): Promise<void> {
  await wallet.unlinkSolanaAddress()
}
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
          <p v-if="wallet.did" style="margin-top: 0.125rem; font-size: var(--ext-text-xs); color: var(--ext-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
            {{ wallet.did }}
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

    <!-- Linked Solana Wallet -->
    <div class="ext-card" style="padding: 1rem">
      <p style="font-size: var(--ext-text-xs); font-weight: 600; color: var(--ext-text-primary); margin-bottom: 0.75rem">Linked Solana Wallet</p>

      <!-- Not linked -->
      <template v-if="!wallet.linkedSolanaAddress">
        <div class="ext-empty">
          <LinkIcon class="ext-empty__icon" />
          <p class="ext-empty__title">
            Link your Solana wallet from the
            <span style="color: var(--ext-brand-secondary); font-weight: 500">Identity Wallet</span>
            page in the CORTEX dashboard.
          </p>
          <p class="ext-empty__desc">
            Connect your wallet there, then use "Link to Vault" to push the address here.
          </p>
        </div>
      </template>

      <!-- Linked -->
      <template v-else>
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <span style="border-radius: var(--ext-radius-md); background: var(--ext-bg-surface-hover); padding: 0.25rem 0.5rem; font-size: var(--ext-text-xs); font-family: monospace; color: var(--ext-text-secondary)">
            {{ shortenAddress(wallet.linkedSolanaAddress) }}
          </span>
          <button
            style="font-size: var(--ext-text-2xs); color: var(--ext-brand-secondary); cursor: pointer; display: flex; align-items: center; gap: 0.125rem; background: none; border: none"
            @click="openExplorer(wallet.linkedSolanaAddress!)"
          >
            Explorer
            <ArrowTopRightOnSquareIcon style="width: 0.75rem; height: 0.75rem" />
          </button>
          <button
            style="margin-left: auto; font-size: var(--ext-text-2xs); color: var(--ext-error); cursor: pointer; background: none; border: none"
            @click="unlinkWallet"
          >
            Unlink
          </button>
        </div>

        <!-- Token list -->
        <div style="margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem">
          <div style="display: flex; align-items: center; justify-content: space-between">
            <p class="ext-detail__label" style="margin-bottom: 0">Tokens</p>
            <button
              style="display: flex; align-items: center; gap: 0.25rem; font-size: var(--ext-text-2xs); color: var(--ext-brand-secondary); cursor: pointer; background: none; border: none"
              :disabled="loading"
              @click="refresh"
            >
              <ArrowPathIcon style="width: 0.75rem; height: 0.75rem" :class="{ 'animate-spin': loading }" />
              Refresh
            </button>
          </div>

          <div v-if="loading && tokens.length === 0" style="text-align: center; padding: 0.75rem">
            <ArrowPathIcon class="animate-spin" style="width: 1.25rem; height: 1.25rem; color: var(--ext-text-muted); margin: 0 auto" />
          </div>

          <p v-else-if="tokenError" style="font-size: var(--ext-text-2xs); color: var(--ext-error); text-align: center; padding: 0.5rem">
            {{ tokenError }}
          </p>

          <p v-else-if="tokens.length === 0" style="font-size: var(--ext-text-2xs); color: var(--ext-text-muted); text-align: center; padding: 0.5rem">
            No tokens found for this wallet.
          </p>

          <SolanaTokenCard
            v-for="token in tokens"
            :key="token.mint"
            :token="token"
          />
        </div>
      </template>
    </div>
  </div>
</template>
