<script setup lang="ts">
/**
 * Per-tab verdict card — the popup surface for site state.
 *
 * Lives at the top of HomeView. Reads the active tab, runs the same
 * computeStateForUrl that the toolbar tracker uses, surfaces the verdict +
 * institution metadata, and offers state-appropriate actions (Trust /
 * Report / Unpin / Unblock / View details).
 *
 * Anti-phishing primary, identity secondary — the trust verdict is the
 * universal value prop, identity is optional and demoted to a footer link
 * in the parent view.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  CheckBadgeIcon,
  GlobeAltIcon,
} from '@heroicons/vue/24/outline'
import { computeStateForUrl, type TrustState } from '@/utils/tab-state'
import { lookupHost, type RegistryEntry } from '@/utils/trust-registry'
import { isPinned, pinSite, unpinSite } from '@/utils/pin-store'
import { isBlocked, unblockSite } from '@/utils/blocklist-store'
import ReportSiteDialog from './ReportSiteDialog.vue'

const { t } = useI18n()

const loading = ref(true)
const host = ref<string | null>(null)
const state = ref<TrustState>('neutral')
const institution = ref<RegistryEntry | null>(null)
const pinned = ref(false)
const blocked = ref(false)
const showReport = ref(false)
const busy = ref(false)

async function loadCurrentTab(): Promise<void> {
  loading.value = true
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? null

    if (!url || !/^https?:/.test(url)) {
      host.value = null
      state.value = 'neutral'
      institution.value = null
      pinned.value = false
      blocked.value = false
      return
    }

    const u = new URL(url)
    host.value = u.host.toLowerCase().replace(/^www\./, '')

    state.value = await computeStateForUrl(url)
    institution.value = await lookupHost(host.value)
    pinned.value = await isPinned(host.value)
    blocked.value = await isBlocked(host.value)
  } finally {
    loading.value = false
  }
}

onMounted(loadCurrentTab)

const variant = computed(() => {
  // Single source of truth for state → visual treatment.
  switch (state.value) {
    case 'red':
      return {
        ring: 'ring-red-500/50',
        bg: 'bg-red-950/50',
        iconBg: 'bg-red-950/60',
        iconRing: 'ring-red-500/40',
        icon: NoSymbolIcon,
        iconClass: 'text-red-400',
        label: blocked.value ? t('home.currentSite.redLabel') : t('home.currentSite.redLabel'),
        reason: blocked.value
          ? t('home.currentSite.redBlockedReason')
          : t('home.currentSite.redReason'),
        labelClass: 'text-red-300',
      }
    case 'yellow-heuristic':
    case 'yellow-cert':
      return {
        ring: 'ring-yellow-500/50',
        bg: 'bg-yellow-950/40',
        iconBg: 'bg-yellow-950/60',
        iconRing: 'ring-yellow-500/40',
        icon: ExclamationTriangleIcon,
        iconClass: 'text-yellow-400',
        label: t('home.currentSite.yellowLabel'),
        reason: t('home.currentSite.yellowReason'),
        labelClass: 'text-yellow-300',
      }
    case 'green-verified':
      return {
        ring: 'ring-emerald-500/40',
        bg: 'bg-emerald-950/40',
        iconBg: 'bg-emerald-950/60',
        iconRing: 'ring-emerald-500/40',
        icon: CheckBadgeIcon,
        iconClass: 'text-emerald-400',
        label: t('home.currentSite.verifiedLabel'),
        reason: null,
        labelClass: 'text-emerald-300',
      }
    case 'green-pinned':
      return {
        ring: 'ring-emerald-500/30',
        bg: 'bg-emerald-950/30',
        iconBg: 'bg-emerald-950/60',
        iconRing: 'ring-emerald-500/40',
        icon: ShieldCheckIcon,
        iconClass: 'text-emerald-400',
        label: t('home.currentSite.pinnedLabel'),
        reason: null,
        labelClass: 'text-emerald-300',
      }
    default:
      return {
        ring: 'ring-slate-700',
        bg: 'bg-slate-900',
        iconBg: 'bg-slate-800',
        iconRing: 'ring-slate-700',
        icon: GlobeAltIcon,
        iconClass: 'text-slate-400',
        label: t('home.currentSite.neutralLabel'),
        reason: null,
        labelClass: 'text-slate-300',
      }
  }
})

const displayTitle = computed(() => institution.value?.name ?? host.value ?? '—')

async function trustSite(): Promise<void> {
  if (!host.value || busy.value) return
  busy.value = true
  try {
    // Trusting unblocks if user had previously blocked, then pins.
    if (blocked.value) await unblockSite(host.value)
    await pinSite(host.value)
    await loadCurrentTab()
  } finally {
    busy.value = false
  }
}

async function untrustCurrent(): Promise<void> {
  if (!host.value || busy.value) return
  busy.value = true
  try {
    await unpinSite(host.value)
    await loadCurrentTab()
  } finally {
    busy.value = false
  }
}

function openReportDialog(): void {
  showReport.value = true
}

async function onReportClosed(): Promise<void> {
  showReport.value = false
  await loadCurrentTab()
}

function goToSafety(): void {
  void chrome.tabs.update({ url: 'about:blank' })
}
</script>

<template>
  <div
    class="rounded-lg p-4 ring-1 transition-colors"
    :class="[variant.ring, variant.bg]"
  >
    <div v-if="loading" class="text-xs text-slate-400">
      {{ t('home.currentSite.loading') }}
    </div>

    <div v-else-if="!host" class="text-xs text-slate-400">
      {{ t('home.currentSite.noSite') }}
    </div>

    <template v-else>
      <div class="flex items-start gap-3">
        <div
          class="flex size-9 shrink-0 items-center justify-center rounded-full ring-1"
          :class="[variant.iconBg, variant.iconRing]"
        >
          <component :is="variant.icon" class="size-5" :class="variant.iconClass" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-[11px] font-semibold uppercase tracking-wider" :class="variant.labelClass">
            {{ variant.label }}
          </p>
          <p class="mt-0.5 truncate text-sm font-semibold text-white">
            {{ displayTitle }}
          </p>
          <p v-if="institution" class="truncate text-[11px] text-slate-400">
            {{ host }} · {{ t('home.currentSite.categoryPrefix') }}: {{ institution.category }}
          </p>
          <p v-else class="truncate text-[11px] text-slate-400">{{ host }}</p>
          <p v-if="variant.reason" class="mt-1 text-[11px] leading-relaxed" :class="variant.labelClass">
            {{ variant.reason }}
          </p>
        </div>
      </div>

      <!-- State-driven CTAs -->
      <div class="mt-3 flex flex-wrap gap-2">
        <!-- RED — report primary, go back secondary -->
        <template v-if="state === 'red'">
          <button
            type="button"
            class="flex-1 rounded-md bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
            :disabled="busy"
            @click="openReportDialog"
          >
            {{ t('home.currentSite.reportAction') }}
          </button>
          <button
            type="button"
            class="rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            :disabled="busy"
            @click="goToSafety"
          >
            {{ t('home.currentSite.backToSafetyAction') }}
          </button>
        </template>

        <!-- GREEN-PINNED — already trusted, offer untrust -->
        <template v-else-if="state === 'green-pinned'">
          <button
            type="button"
            class="flex-1 rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            :disabled="busy"
            @click="untrustCurrent"
          >
            {{ t('home.currentSite.untrustAction') }}
          </button>
        </template>

        <!-- All other states (neutral / yellow / green-verified) — trust + report -->
        <template v-else>
          <button
            type="button"
            class="flex-1 rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-60"
            :disabled="busy"
            @click="trustSite"
          >
            {{ t('home.currentSite.trustAction') }}
          </button>
          <button
            type="button"
            class="rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60"
            :disabled="busy"
            @click="openReportDialog"
          >
            {{ t('home.currentSite.reportAction') }}
          </button>
        </template>
      </div>
    </template>

    <ReportSiteDialog
      v-if="showReport && host"
      :host="host"
      :collided-with="institution?.host"
      @close="onReportClosed"
    />
  </div>
</template>
