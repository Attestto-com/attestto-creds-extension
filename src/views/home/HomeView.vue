<script setup lang="ts">
/**
 * Popup home — anti-phishing first, identity optional.
 *
 * Restructured 2026-06-29 per Eduardo: anti-phishing is the universal
 * always-on value prop; identity is a secondary optional feature. The big
 * "Set up identity" CTA that previously dominated the first-run view is
 * demoted to a small footer link; the per-tab verdict card (with
 * Trust/Report CTAs) is now the primary surface for every user, with or
 * without identity.
 *
 * Layout (top → bottom):
 *
 *   1. CurrentSiteCard           — verdict + state-driven CTAs (always)
 *   2. Trusted sites grid        — only if pins exist
 *   3. Identity row              — only if identity exists
 *   4. Footer identity link      — only if NO identity (small, no purple)
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import { useRouter } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import { listPins, type PinRecord } from '@/utils/pin-store'
import CurrentSiteCard from './CurrentSiteCard.vue'

const { t } = useI18n()
const router = useRouter()
const wallet = useWalletStore()

const pins = ref<PinRecord[]>([])
const loading = ref(true)

const PLATFORM_URL = 'https://app.attestto.com'

const identities = computed(() =>
  wallet.linkedIdentities.map((i) => ({
    did: i.did,
    label: i.label,
    credentialCount: i.credentials.length,
  })),
)

onMounted(async () => {
  await wallet.loadPublicData()
  try {
    pins.value = await listPins()
  } catch {
    pins.value = []
  }
  loading.value = false
})

function selectIdentity(did: string): void {
  router.push({ name: 'identity-detail', params: { did: encodeURIComponent(did) } })
}

function openSettings(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') })
}

function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`
}

const FIRST_THREE = 3
const visibleTrustedSites = computed(() => pins.value.slice(0, FIRST_THREE))
const overflowTrustedCount = computed(() => Math.max(0, pins.value.length - FIRST_THREE))
</script>

<template>
  <div class="space-y-3">
    <!-- Per-tab verdict card — always at top, before anything else loads.
         Renders its own loading state internally. -->
    <CurrentSiteCard />

    <div v-if="loading" class="px-1 text-[11px] text-slate-500">{{ t('common.loading') }}</div>

    <template v-else>
      <!-- Trusted sites grid — only if user has pinned anything -->
      <section v-if="pins.length > 0" class="rounded-lg border border-slate-700 bg-slate-900 p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[10px] font-medium uppercase tracking-wider text-slate-500">
            {{ t('home.trustedSites.title') }}
          </span>
          <button
            type="button"
            class="text-[11px] text-violet-300 hover:text-violet-200"
            @click="openSettings"
          >
            {{ t('home.trustedSites.manage') }}
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <a
            v-for="pin in visibleTrustedSites"
            :key="pin.domain"
            :href="`https://${pin.domain}`"
            target="_blank"
            rel="noopener noreferrer"
            class="flex size-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 hover:border-slate-500"
            :title="pin.domain"
          >
            <img
              :src="faviconUrl(pin.domain)"
              :alt="pin.domain"
              class="size-5"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
          </a>
          <button
            v-if="overflowTrustedCount > 0"
            type="button"
            class="flex size-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-[11px] font-medium text-slate-300 hover:border-slate-500"
            @click="openSettings"
          >
            +{{ overflowTrustedCount }}
          </button>
        </div>
      </section>

      <!-- Identity row — only if identity exists -->
      <section v-if="identities.length > 0" class="rounded-lg border border-slate-700 bg-slate-900">
        <button
          v-for="identity in identities"
          :key="identity.did"
          type="button"
          class="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800"
          @click="selectIdentity(identity.did)"
        >
          <div class="flex size-8 shrink-0 items-center justify-center rounded-full bg-violet-950/60 text-[11px] font-medium text-violet-300 ring-1 ring-violet-500/40">
            {{ identity.label.charAt(0).toUpperCase() }}
          </div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-white">{{ identity.label }}</p>
            <p class="text-[10px] text-slate-400">{{ t('home.identity.active') }}</p>
          </div>
          <ChevronDownIcon class="size-4 text-slate-500" />
        </button>
      </section>

      <!-- Identity footer — only if NO identity. Small, no purple, opt-in framing.
           Anti-phishing already works without this step. -->
      <div
        v-else
        class="px-1 pt-1 text-center text-[11px] text-slate-500"
      >
        {{ t('home.currentSite.identityFooter') }}
        <a
          :href="`${PLATFORM_URL}/onboarding?src=extension`"
          target="_blank"
          rel="noopener noreferrer"
          class="ml-1 text-violet-400 hover:text-violet-300"
        >{{ t('home.currentSite.setUpLink') }}</a>
      </div>
    </template>
  </div>
</template>
