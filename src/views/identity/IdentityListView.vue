<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { FingerPrintIcon, PlusCircleIcon, ArrowDownTrayIcon, IdentificationIcon } from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import type { LinkedIdentity } from '@/stores/wallet'
import PopupPanel from '@/components/layout/PopupPanel.vue'
import PanelButton from '@/components/layout/PanelButton.vue'
import { PLATFORM_URL } from '@/config/app'

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

const ONBOARDING_PATH = '/onboarding'
const UNLOCK_PATH = '/lock'

function selectIdentity(did: string): void {
  router.push({ name: 'identity-detail', params: { did: encodeURIComponent(did) } })
}

/** Onboarding step 1 — open the full-page extension flow in a new tab. */
function verifyIdOffline(): void {
  chrome.runtime.openOptionsPage()
}
</script>

<template>
  <div class="space-y-3">
    <p
      v-if="identities.length > 0"
      class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500"
    >
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

    <!-- Onboarding — no platform-synced identity yet (light "welcome" panel) -->
    <PopupPanel v-if="identities.length === 0" tone="light">
      <div class="text-center">
        <div
          class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white/70 shadow-sm"
        >
          <FingerPrintIcon class="h-7 w-7 text-indigo-600" />
        </div>
        <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Welcome to
        </p>
        <p class="mt-0.5 text-lg font-bold text-slate-900">Attestto ID</p>
        <p class="mx-auto mt-1.5 max-w-[16rem] text-[11px] leading-relaxed text-slate-600">
          Your digital identity and credentials, held in this wallet — never on the sites you use.
        </p>

        <div class="mt-5 space-y-2.5">
          <PanelButton variant="primary" tone="light" @click="verifyIdOffline">
            <IdentificationIcon class="h-4 w-4" />
            1. Verify your ID offline
          </PanelButton>
          <PanelButton
            variant="secondary"
            tone="light"
            :href="`${PLATFORM_URL}${ONBOARDING_PATH}?src=extension`"
            target="_blank"
          >
            <PlusCircleIcon class="h-4 w-4" />
            Get Started
          </PanelButton>
          <PanelButton
            variant="secondary"
            tone="light"
            :href="`${PLATFORM_URL}${UNLOCK_PATH}?src=extension`"
            target="_blank"
          >
            <ArrowDownTrayIcon class="h-4 w-4" />
            Log in to sync
          </PanelButton>
        </div>
      </div>
    </PopupPanel>
  </div>
</template>
