<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { FingerPrintIcon } from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import type { LinkedIdentity } from '@/stores/wallet'

const router = useRouter()
const wallet = useWalletStore()

interface IdentityItem {
  did: string
  label: string
  synced: boolean
  credentialCount: number
}

/** Show platform-synced identities from the multi-identity vault model */
const identities = computed<IdentityItem[]>(() => {
  return wallet.linkedIdentities.map((identity: LinkedIdentity) => ({
    did: identity.did,
    label: identity.label,
    synced: true,
    credentialCount: identity.credentials.length,
  }))
})

const PLATFORM_URL = 'https://attestto.net'

function selectIdentity(did: string): void {
  router.push({ name: 'identity-detail', params: { did: encodeURIComponent(did) } })
}
</script>

<template>
  <div class="space-y-3">
    <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
      My Identities
    </p>

    <!-- Identity cards -->
    <button
      v-for="identity in identities"
      :key="identity.did"
      class="flex w-full items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left hover:bg-slate-800 transition-colors"
      @click="selectIdentity(identity.did)"
    >
      <div class="relative">
        <FingerPrintIcon class="h-6 w-6 text-indigo-400" />
        <span
          class="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full"
          :class="identity.synced ? 'bg-emerald-400' : 'bg-slate-500'"
        />
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-white truncate">{{ identity.label }}</p>
        <p v-if="identity.credentialCount > 0" class="text-[10px] text-slate-400">
          {{ identity.credentialCount }} credential{{ identity.credentialCount !== 1 ? 's' : '' }}
        </p>
      </div>
      <svg class="h-4 w-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
    </button>

    <!-- Onboarding — no platform-synced identity yet -->
    <div
      v-if="identities.length === 0"
      class="rounded-lg border border-slate-700 bg-slate-900 p-6 text-center space-y-4"
    >
      <FingerPrintIcon class="mx-auto h-10 w-10 text-indigo-400" />
      <div>
        <p class="text-sm font-medium text-white">Set up your identity</p>
        <p class="mt-1 text-[11px] text-slate-400 leading-relaxed">
          Connect to the Attestto platform to receive your digital identity.
        </p>
      </div>

      <a
        :href="`${PLATFORM_URL}/app/register?src=extension`"
        target="_blank"
        class="block w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
      >
        Get Started
      </a>

      <p class="text-[10px] text-slate-500">
        Already have an account?
        <a
          :href="`${PLATFORM_URL}/app/login?src=extension`"
          target="_blank"
          class="text-indigo-400 hover:text-indigo-300"
        >
          Log in to sync
        </a>
      </p>
    </div>
  </div>
</template>
