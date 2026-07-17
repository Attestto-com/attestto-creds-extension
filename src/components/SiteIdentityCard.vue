<script setup lang="ts">
/**
 * SiteIdentityCard — shared "site certificate" card.
 *
 * Rendered by BOTH the toolbar popup (HomeView) and the approval window, so the
 * two surfaces look like one product. Purely props-driven: each surface reads
 * its data differently (active tab vs. request origin) and passes it in.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ShieldCheckIcon,
  GlobeAltIcon,
  LockClosedIcon,
  LockOpenIcon,
  DocumentCheckIcon,
  ExclamationTriangleIcon,
  BuildingLibraryIcon,
} from '@heroicons/vue/24/outline'
import { lookupTls, snapshotDate, type TlsSnapshotRow } from '@/utils/tls-snapshot'
import type { TrustState } from '@/utils/tab-state'
import PopupPanel from '@/components/layout/PopupPanel.vue'

const props = defineProps<{
  host: string
  siteName?: string | null
  isSecure: boolean
  faviconSrc?: string | null
  /** true → the user has signed in to this origin before (returning site). */
  hasIdentity: boolean
  createdAt?: string | null
  lastUsedAt?: string | null
  /** Toolbar trust verdict for this host. Omitted on surfaces that don't compute it. */
  trustState?: TrustState
  /** Official institution name from the trust registry — pre-configured sites only. */
  institutionName?: string | null
  /** Institution category from the registry (e.g. "Instituciones Autónomas"). */
  institutionCategory?: string | null
  /** Show the phishing-proof explainer — only while creating a new identity. */
  showPhishingProof?: boolean
}>()

/** Registry title, capped at 3 words (one per line). Pre-configured sites only. */
const titleLines = computed<string[]>(() =>
  props.institutionName ? props.institutionName.split(/\s+/).filter(Boolean).slice(0, 3) : [],
)

const emit = defineEmits<{ (e: 'backToSafety'): void }>()

const { t } = useI18n()

/**
 * Trust-state banner shown at the top of the card. Mirrors the unspoofable
 * toolbar icon verdict (computeStateForUrl) so the passive cue and the popup
 * agree: red = impersonation/blocklist, amber = caution, green = verified/pinned.
 */
type BannerKind = 'danger' | 'caution' | 'ok'
const BANNER_STYLES: Record<BannerKind, { box: string; text: string; reason: string; icon: typeof ShieldCheckIcon }> = {
  danger: { box: 'border-red-500/40 bg-red-500/10', text: 'text-red-300', reason: 'text-red-300/80', icon: ExclamationTriangleIcon },
  caution: { box: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-300', reason: 'text-amber-300/80', icon: ExclamationTriangleIcon },
  ok: { box: 'border-emerald-500/30 bg-emerald-500/10', text: 'text-emerald-300', reason: '', icon: ShieldCheckIcon },
}

const stateBanner = computed<{ kind: BannerKind; label: string; reason: string | null } | null>(() => {
  switch (props.trustState) {
    case 'red':
      return { kind: 'danger', label: t('home.currentSite.redLabel'), reason: t('home.currentSite.redReason') }
    case 'yellow-heuristic':
    case 'yellow-cert':
      return { kind: 'caution', label: t('home.currentSite.yellowLabel'), reason: t('home.currentSite.yellowReason') }
    case 'green-verified':
      return { kind: 'ok', label: t('home.currentSite.verifiedLabel'), reason: null }
    case 'green-pinned':
      return { kind: 'ok', label: t('home.currentSite.pinnedLabel'), reason: null }
    default:
      return null
  }
})

const bannerStyle = computed(() => (stateBanner.value ? BANNER_STYLES[stateBanner.value.kind] : null))
const faviconOk = ref(true)

/**
 * Bundled CR public-sector TLS classification for the active host, if any.
 *
 * MV3 can't read the live served cert, so this is a lookup into the packaged
 * scanner snapshot keyed by hostname. `null` → host not in the snapshot (render
 * nothing beyond a subtle note).
 */
const tls = ref<TlsSnapshotRow | null>(null)

/** Scan date of the bundled snapshot ('generatedAt'), populated after load. */
const tlsSnapshotDate = ref<string | null>(null)

async function loadTls(host: string | null | undefined): Promise<void> {
  tls.value = host ? await lookupTls(host) : null
  // `snapshotDate()` is only meaningful once the snapshot has been fetched,
  // which `lookupTls` guarantees.
  tlsSnapshotDate.value = snapshotDate()
}

onMounted(() => void loadTls(props.host))
watch(
  () => props.host,
  (h) => void loadTls(h),
)

/** Tailwind classes for the DV/OV/EV validation-tier chip. */
const tierChipClass = computed(() => {
  switch (tls.value?.validationTier) {
    case 'EV':
      return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
    case 'OV':
      return 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
    case 'DV':
      return 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
    default:
      return 'bg-slate-700/40 text-white/70 ring-slate-600/40'
  }
})

/**
 * Expiry severity: `expired` (red) when the cert is past its validity or the
 * remaining days went negative, `soon` (amber) when fewer than 30 days remain,
 * otherwise `ok` (normal).
 */
const expirySeverity = computed<'expired' | 'soon' | 'ok'>(() => {
  const c = tls.value
  if (!c) return 'ok'
  if (c.expired || (typeof c.daysToExpiry === 'number' && c.daysToExpiry < 0)) return 'expired'
  if (typeof c.daysToExpiry === 'number' && c.daysToExpiry < 30) return 'soon'
  return 'ok'
})

/** Text color for the expiry line — follows the card's chip color language. */
const expiryTextClass = computed(() => {
  switch (expirySeverity.value) {
    case 'expired':
      return 'text-red-400'
    case 'soon':
      return 'text-amber-300'
    default:
      return 'text-white/85'
  }
})

/** Muted label color paired with `expiryTextClass`. */
const expiryLabelClass = computed(() => {
  switch (expirySeverity.value) {
    case 'expired':
      return 'text-red-400/80'
    case 'soon':
      return 'text-amber-300/80'
    default:
      return 'text-white/70'
  }
})

/** Absolute expiry date derived from the row's `validTo`, or null when absent. */
const expiryAbsolute = computed<string | null>(() => {
  const iso = tls.value?.validTo
  if (!iso) return null
  const dt = new Date(iso)
  return Number.isNaN(dt.getTime())
    ? null
    : dt.toISOString().slice(0, 10)
})

function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  const dt = new Date(iso)
  return Number.isNaN(dt.getTime())
    ? '—'
    : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <PopupPanel tone="dark" dense>
    <div class="space-y-3">
    <!-- 0. Trust-state banner — red danger (impersonation/blocklist), amber
         caution, or green verified/pinned. Mirrors the unspoofable toolbar icon. -->
    <div v-if="stateBanner && bannerStyle" class="rounded-md border p-2.5" :class="bannerStyle.box">
      <p class="flex items-center gap-1.5 text-sm font-semibold" :class="bannerStyle.text">
        <component :is="bannerStyle.icon" class="size-4 shrink-0" />
        {{ stateBanner.label }}
      </p>
      <p v-if="stateBanner.reason" class="mt-1 text-xs" :class="bannerStyle.reason">
        {{ stateBanner.reason }}
      </p>
      <button
        v-if="stateBanner.kind === 'danger'"
        type="button"
        class="mt-2 w-full rounded-md bg-red-500 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-red-600"
        @click="emit('backToSafety')"
      >
        {{ t('home.currentSite.backToSafetyAction') }}
      </button>
    </div>

    <!-- 1. Logo · registry title · domain (with inline lock) -->
    <div class="flex items-center gap-3">
      <div class="flex size-14 shrink-0 items-center justify-center rounded-full bg-slate-800 ring-1 ring-slate-700">
        <img
          v-if="faviconSrc && faviconOk"
          :src="faviconSrc"
          :alt="host"
          class="size-9 rounded"
          referrerpolicy="no-referrer"
          @error="faviconOk = false"
        />
        <GlobeAltIcon v-else class="size-9 text-white" />
      </div>
      <div class="min-w-0 flex-1">
        <!-- Only pre-configured (registry) sites get a title; max 3 words, one per line. -->
        <p v-if="titleLines.length" class="text-base font-semibold leading-tight text-white">
          <span v-for="(word, i) in titleLines" :key="i" class="block truncate">{{ word }}</span>
        </p>
        <!-- Domain + lock on one line. -->
        <p
          class="flex items-center gap-1.5"
          :class="titleLines.length ? 'mt-0.5 text-sm text-white/70' : 'text-base font-semibold text-white'"
        >
          <component
            :is="isSecure ? LockClosedIcon : LockOpenIcon"
            class="size-4 shrink-0"
            :class="isSecure ? 'text-emerald-400' : 'text-amber-400'"
          />
          <span class="truncate">{{ host }}</span>
        </p>
      </div>
    </div>

    <!-- 2. Who is — the institution behind the site, from the trust registry.
         Hidden entirely when we have no registry match (no filler). -->
    <div
      v-if="institutionName"
      class="rounded-md border border-slate-800 bg-slate-950/40 p-2.5"
    >
      <p class="text-xs font-medium uppercase tracking-wider text-white/70">
        {{ t('home.siteCert.whois') }}
      </p>
      <p class="mt-1 flex items-center gap-1.5 text-sm text-white">
        <BuildingLibraryIcon class="size-4 shrink-0 text-white/70" />
        <span class="truncate">
          {{ institutionName }}<template v-if="institutionCategory"> · {{ institutionCategory }}</template>
        </span>
      </p>
    </div>

    <!-- 3. Accounts — the identities the user has here. Hidden when none. -->
    <div
      v-if="hasIdentity"
      class="rounded-md border border-slate-800 bg-slate-950/40 p-2.5"
    >
      <p class="text-xs font-medium uppercase tracking-wider text-white/70">
        {{ t('home.siteCert.accounts') }}
      </p>
      <p class="mt-1 flex items-start gap-1.5 text-sm text-white">
        <ShieldCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-400" />
        {{ t('home.siteCert.levelBasic') }}
      </p>
      <div v-if="createdAt || lastUsedAt" class="mt-1.5 space-y-0.5 text-sm text-white/85">
        <p>{{ t('home.siteCert.created') }}: {{ fmtDate(createdAt) }}</p>
        <p>{{ t('home.siteCert.lastUsed') }}: {{ fmtDate(lastUsedAt) }}</p>
      </div>
    </div>

    <!-- 4. TLS certificate — bundled CR public-sector snapshot (MV3 can't read
         the live cert, so we display what our scanner recorded, keyed by host). -->
    <div v-if="tls" class="rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
      <p class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-white/70">
        <DocumentCheckIcon class="size-4 text-white/70" />
        {{ t('home.siteCert.tlsTitle') }}
      </p>

      <!-- Failed scan — show the honest error, skip classification fields. -->
      <p v-if="!tls.ok" class="mt-1 flex items-start gap-1.5 text-sm text-amber-300">
        <LockOpenIcon class="mt-0.5 size-4 shrink-0" />
        {{ t('home.siteCert.tlsScanError') }}
      </p>

      <template v-else>
        <div class="mt-1.5 space-y-1 text-sm text-white/85">
          <!-- CA + tier -->
          <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-white/70">{{ t('home.siteCert.tlsCa') }}:</span>
            <span class="font-medium text-white">{{ tls.ca }}</span>
            <span
              class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1"
              :class="tierChipClass"
            >
              {{ tls.validationTier }}
            </span>
          </p>

          <!-- Free vs paid -->
          <p>
            <span class="text-white/70">{{ t('home.siteCert.tlsTier') }}:</span>
            {{ tls.isFreeCA ? t('home.siteCert.tlsFree') : t('home.siteCert.tlsPaid') }}
          </p>

          <!-- Expiry — amber under 30 days, red when expired/past. -->
          <p :class="expiryTextClass">
            <span :class="expiryLabelClass">
              {{ t('home.siteCert.tlsExpiry') }}:
            </span>
            <template v-if="tls.expired">{{ t('home.siteCert.tlsExpired') }}</template>
            <template v-else-if="typeof tls.daysToExpiry === 'number'">
              {{ t('home.siteCert.tlsExpiryDays', { days: tls.daysToExpiry })
              }}<template v-if="expiryAbsolute"> ({{ expiryAbsolute }})</template>
            </template>
            <template v-else>—</template>
          </p>
        </div>
      </template>

      <p class="mt-1.5 text-xs text-white/50">
        {{
          tlsSnapshotDate
            ? t('home.siteCert.tlsSnapshotNoteDated', { date: tlsSnapshotDate })
            : t('home.siteCert.tlsSnapshotNote')
        }}
      </p>
    </div>

    <!-- 5. Anti-phishing guarantee — only while creating a new identity here.
         Explains WHY a lookalike site can't harvest it: per-origin binding + local keys. -->
    <div
      v-if="showPhishingProof"
      class="flex items-start gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5"
    >
      <ShieldCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-400" />
      <p class="text-xs leading-relaxed text-white/80">
        {{ t('home.siteCert.antiPhishing') }}
      </p>
    </div>
    </div>
  </PopupPanel>
</template>
