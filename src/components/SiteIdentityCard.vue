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
  ChevronRightIcon,
  ExclamationTriangleIcon,
  BuildingLibraryIcon,
} from '@heroicons/vue/24/outline'
import { lookupTls, snapshotDate, type TlsSnapshotRow } from '@/utils/tls-snapshot'
import type { TrustState } from '@/utils/tab-state'
import PopupPanel from '@/components/layout/PopupPanel.vue'
import TlsCertificateCard from '@/components/TlsCertificateCard.vue'

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
  /**
   * How to present the TLS certificate:
   *   'inline' (default) — render the full card here (approval window).
   *   'link'             — render a "View certificate →" row, emit `viewTls`.
   *   'hidden'           — don't render TLS at all.
   */
  tlsMode?: 'inline' | 'link' | 'hidden'
}>()

/** Registry title, capped at 3 words (one per line). Pre-configured sites only. */
const titleLines = computed<string[]>(() =>
  props.institutionName ? props.institutionName.split(/\s+/).filter(Boolean).slice(0, 3) : [],
)

/** Site title is bright green once the user has an account here, white otherwise. */
const titleColor = computed(() => (props.hasIdentity ? 'text-emerald-400' : 'text-white'))

/** Full origin with scheme, shown below the site title (e.g. https://claude.ai). */
const displayUrl = computed(() => `${props.isSecure ? 'https://' : 'http://'}${props.host}`)

const emit = defineEmits<{ (e: 'backToSafety'): void; (e: 'viewTls'): void }>()

const { t } = useI18n()

/** Effective TLS presentation mode (defaults to inline for the approval window). */
const effectiveTlsMode = computed(() => props.tlsMode ?? 'inline')

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

function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  const dt = new Date(iso)
  return Number.isNaN(dt.getTime())
    ? '—'
    : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <PopupPanel tone="dark" dense :danger="!isSecure">
    <div class="space-y-3">
    <!-- 1. Favicon · site title · full http/s domain (below, with brighter lock) -->
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
        <!-- Site title. Registry sites use the institution name (max 3 words,
             one per line); everything else uses the site/host name. White by
             default, bright green once the user has an account here. -->
        <p v-if="titleLines.length" class="text-base font-semibold leading-tight" :class="titleColor">
          <span v-for="(word, i) in titleLines" :key="i" class="block truncate">{{ word }}</span>
        </p>
        <p v-else class="truncate text-base font-semibold leading-tight" :class="titleColor">
          {{ siteName || host }}
        </p>

        <!-- Full http/s domain, below the title, with a bigger, brighter lock. -->
        <p class="mt-0.5 flex items-center gap-1.5 text-sm text-white/70">
          <component
            :is="isSecure ? LockClosedIcon : LockOpenIcon"
            class="size-5 shrink-0"
            :class="isSecure ? 'text-emerald-400' : 'text-red-400'"
          />
          <span class="truncate">{{ displayUrl }}</span>
        </p>
      </div>
    </div>

    <!-- 1b. Trust-state banner — shown BELOW the domain so the site identity
         (URL) reads first, then the verdict: red danger (impersonation/
         blocklist), amber caution, or green verified/pinned. Mirrors the
         unspoofable toolbar icon. -->
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
         the live cert, so we display what our scanner recorded, keyed by host).
         Inline on the approval window; a link to its own screen in the popup. -->
    <TlsCertificateCard
      v-if="tls && effectiveTlsMode === 'inline'"
      :tls="tls"
      :snapshot-date="tlsSnapshotDate"
    />
    <button
      v-else-if="tls && effectiveTlsMode === 'link'"
      type="button"
      class="flex w-full items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 p-2.5 text-left transition-colors hover:bg-slate-900/60"
      @click="emit('viewTls')"
    >
      <DocumentCheckIcon class="size-4 shrink-0 text-white/70" />
      <span class="flex-1 text-sm text-white">{{ t('home.siteCert.tlsTitle') }}</span>
      <span
        class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-slate-600/40 text-white/70"
      >
        {{ tls.validationTier }}
      </span>
      <ChevronRightIcon class="size-4 shrink-0 text-slate-500" />
    </button>

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
