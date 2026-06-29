<script setup lang="ts">
/**
 * Popup home — the sole trust surface (ATT-724 + ATT-726).
 *
 * The on-page bar was removed because any on-page UI is inherently spoofable
 * (a malicious site can fake a green bar or hide a red one). The browser-
 * chrome surfaces — toolbar icon, popup-after-click, notifications — are the
 * only ones the page cannot reach. So the popup is now the authoritative
 * place where trust claims live and where trust-changing actions happen.
 *
 * Two modes per Eduardo's wireframes 2026-06-29:
 *
 *   1. First run (no pins AND no identity) — single focused welcome card.
 *   2. Returning user (has at least one pin OR identity) — dashboard:
 *      trusted-sites avatar grid + identity row.
 *
 * Rules from the wireframes:
 *
 *   - Reflect real state only. No loading apologies. No pre-rendered
 *     placeholders for unbuilt features.
 *   - Less text, more CTAs and icons.
 *
 * OPEN ITEMS:
 *
 *   - Active-tab state card was previously shown here, sourced from the
 *     on-page bar via a chrome.tabs.sendMessage round-trip. With the bar
 *     gone, we don't yet have an authoritative source for per-tab state
 *     (Trust Registry queries land in ATT-630). When that ships, the active
 *     tab card returns here with state derived from Trust Registry + pin
 *     store + cert verifier (ATT-705), all read from the popup directly.
 *   - Toolbar icon color (the unspoofable nudge that replaces the bar) is
 *     ATT-727 work.
 *   - chrome.notifications for RED state is also ATT-727 work.
 *   - Trusted-sites avatars use Google's s2 favicon CDN — leaks pin domains
 *     on each popup open. Acceptable for v0; revisit with local caching
 *     under ATT-723.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldCheckIcon, ChevronDownIcon } from '@heroicons/vue/24/outline'
import { useRouter } from 'vue-router'
import { useWalletStore } from '@/stores/wallet'
import { listPins, type PinRecord } from '@/utils/pin-store'

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

const showDashboard = computed(() => pins.value.length > 0 || identities.value.length > 0)

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
    <div v-if="loading" class="px-1 py-4 text-xs text-slate-500">{{ t('common.loading') }}</div>

    <!-- FIRST RUN — single focused welcome card -->
    <template v-else-if="!showDashboard">
      <div class="rounded-lg border border-slate-700 bg-slate-900 p-4">
        <div class="flex items-start gap-3">
          <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-950/60 ring-1 ring-emerald-500/40">
            <ShieldCheckIcon class="size-5 text-emerald-400" />
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-semibold text-white">{{ t('home.firstRun.title') }}</h2>
            <p class="mt-1 text-xs leading-relaxed text-slate-300">{{ t('home.firstRun.body') }}</p>
          </div>
        </div>

        <a
          :href="`${PLATFORM_URL}/onboarding?src=extension`"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-4 block w-full rounded-lg bg-violet-600 px-4 py-2.5 text-center text-xs font-medium text-white hover:bg-violet-500"
        >
          {{ t('home.firstRun.cta') }}
        </a>

        <p class="mt-2 text-center text-[11px] text-slate-400">
          {{ t('home.firstRun.alreadyHave') }}
          <a
            :href="`${PLATFORM_URL}/lock?src=extension`"
            target="_blank"
            rel="noopener noreferrer"
            class="text-violet-300 hover:text-violet-200"
          >{{ t('home.firstRun.signIn') }}</a>
        </p>

        <div class="mt-4 border-t border-slate-800 pt-3 text-center text-[10px] text-slate-500">
          {{ t('home.firstRun.footer') }}
        </div>
      </div>
    </template>

    <!-- RETURNING USER — dashboard -->
    <template v-else>
      <!-- Trusted sites grid -->
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

      <!-- Identity row -->
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

      <!-- Identity upgrade prompt (has pins but no identity) -->
      <section
        v-else
        class="rounded-lg border border-dashed border-slate-700 bg-slate-950/50 p-3"
      >
        <p class="text-xs text-slate-300">{{ t('home.identity.upgradeBody') }}</p>
        <a
          :href="`${PLATFORM_URL}/onboarding?src=extension`"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-2 inline-block text-[11px] text-violet-300 hover:text-violet-200"
        >
          {{ t('home.identity.setupLink') }}
        </a>
      </section>
    </template>
  </div>
</template>
