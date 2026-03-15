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
  <div class="space-y-4">
    <!-- Status Card -->
    <div
      class="rounded-lg border p-4"
      :class="wallet.isUnlocked
        ? 'border-emerald-700 bg-emerald-950/30'
        : 'border-slate-700 bg-slate-900'"
    >
      <div class="flex items-center gap-3">
        <component
          :is="wallet.isUnlocked ? LockOpenIcon : LockClosedIcon"
          class="h-6 w-6"
          :class="wallet.isUnlocked ? 'text-emerald-400' : 'text-slate-500'"
        />
        <div>
          <p class="text-sm font-semibold text-white">{{ statusLabel }}</p>
          <p v-if="wallet.did" class="mt-0.5 truncate text-xs text-slate-400">
            {{ wallet.did }}
          </p>
          <p v-else class="mt-0.5 text-xs text-slate-500">
            No DID created yet
          </p>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="grid grid-cols-2 gap-2">
      <button
        v-if="!wallet.isUnlocked"
        class="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500"
        @click="wallet.unlock()"
      >
        Unlock Wallet
      </button>
      <button
        v-if="!wallet.did"
        class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
        @click="wallet.createDid()"
      >
        Create DID
      </button>
      <button
        v-if="wallet.isUnlocked"
        class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
        @click="wallet.lock()"
      >
        Lock
      </button>
    </div>

    <!-- Linked Solana Wallet -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-4">
      <p class="text-xs font-semibold text-white mb-3">Linked Solana Wallet</p>

      <!-- Not linked: instruction to link from dashboard -->
      <template v-if="!wallet.linkedSolanaAddress">
        <div class="flex flex-col items-center gap-2 py-3">
          <LinkIcon class="h-8 w-8 text-slate-600" />
          <p class="text-[11px] text-slate-400 text-center leading-relaxed">
            Link your Solana wallet from the
            <span class="text-indigo-400 font-medium">Identity Wallet</span>
            page in the CORTEX dashboard.
          </p>
          <p class="text-[10px] text-slate-500 text-center">
            Connect your wallet there, then use "Link to Vault" to push the address here.
          </p>
        </div>
      </template>

      <!-- Linked: show address + actions -->
      <template v-else>
        <div class="flex items-center gap-2">
          <span class="rounded-md bg-slate-800 px-2 py-1 text-xs font-mono text-slate-300">
            {{ shortenAddress(wallet.linkedSolanaAddress) }}
          </span>
          <button
            class="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-0.5"
            @click="openExplorer(wallet.linkedSolanaAddress!)"
          >
            Explorer
            <ArrowTopRightOnSquareIcon class="h-3 w-3" />
          </button>
          <button
            class="ml-auto text-[10px] text-red-400 hover:text-red-300"
            @click="unlinkWallet"
          >
            Unlink
          </button>
        </div>

        <!-- Token list -->
        <div class="mt-3 space-y-2">
          <div class="flex items-center justify-between">
            <p class="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Tokens</p>
            <button
              class="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300"
              :disabled="loading"
              @click="refresh"
            >
              <ArrowPathIcon class="h-3 w-3" :class="{ 'animate-spin': loading }" />
              Refresh
            </button>
          </div>

          <!-- Loading -->
          <div v-if="loading && tokens.length === 0" class="text-center py-3">
            <ArrowPathIcon class="h-5 w-5 text-slate-500 animate-spin mx-auto" />
          </div>

          <!-- Error -->
          <p v-else-if="tokenError" class="text-[10px] text-red-400 text-center py-2">
            {{ tokenError }}
          </p>

          <!-- Empty -->
          <p v-else-if="tokens.length === 0" class="text-[10px] text-slate-500 text-center py-2">
            No tokens found for this wallet.
          </p>

          <!-- Token cards -->
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
