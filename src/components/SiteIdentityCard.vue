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
} from '@heroicons/vue/24/outline'
import { lookupTls, type TlsSnapshotRow } from '@/utils/tls-snapshot'

const props = defineProps<{
  host: string
  siteName?: string | null
  isSecure: boolean
  faviconSrc?: string | null
  /** true → the user has signed in to this origin before (returning site). */
  hasIdentity: boolean
  createdAt?: string | null
  lastUsedAt?: string | null
}>()

const { t } = useI18n()
const faviconOk = ref(true)

/**
 * Bundled CR public-sector TLS classification for the active host, if any.
 *
 * MV3 can't read the live served cert, so this is a lookup into the packaged
 * scanner snapshot keyed by hostname. `null` → host not in the snapshot (render
 * nothing beyond a subtle note).
 */
const tls = ref<TlsSnapshotRow | null>(null)

async function loadTls(host: string | null | undefined): Promise<void> {
  tls.value = host ? await lookupTls(host) : null
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

/** Expiry is urgent when expired or fewer than 30 days remain. */
const expiryUrgent = computed(() => {
  const c = tls.value
  if (!c) return false
  return c.expired || (typeof c.daysToExpiry === 'number' && c.daysToExpiry < 30)
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
  <div class="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-3">
    <!-- 1. Logo · name · domain · security -->
    <div class="flex items-center gap-3">
      <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-slate-800 ring-1 ring-slate-700">
        <img
          v-if="faviconSrc && faviconOk"
          :src="faviconSrc"
          :alt="host"
          class="size-6 rounded"
          referrerpolicy="no-referrer"
          @error="faviconOk = false"
        />
        <GlobeAltIcon v-else class="size-6 text-white" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-base font-semibold text-white">{{ siteName ?? host }}</p>
        <p v-if="siteName" class="truncate text-sm text-white/80">{{ host }}</p>
        <p class="mt-0.5 flex items-center gap-1.5 text-sm text-white">
          <component
            :is="isSecure ? LockClosedIcon : LockOpenIcon"
            class="size-4"
            :class="isSecure ? 'text-emerald-400' : 'text-amber-400'"
          />
          {{ isSecure ? t('home.siteCert.sslSecure') : t('home.siteCert.sslInsecure') }}
        </p>
      </div>
    </div>

    <!-- 2. Site identity — site's web DID + KYB (pending resolution) -->
    <div class="rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
      <p class="text-xs font-medium uppercase tracking-wider text-white/70">
        {{ t('home.siteCert.siteIdentity') }}
      </p>
      <p class="mt-1 flex items-center gap-1.5 text-sm text-white">
        <GlobeAltIcon class="size-4 text-white/70" />
        {{ t('home.siteCert.notVerified') }}
      </p>
    </div>

    <!-- 3. Your identity here -->
    <div class="rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
      <p class="text-xs font-medium uppercase tracking-wider text-white/70">
        {{ t('home.siteCert.yourIdentity') }}
      </p>
      <template v-if="hasIdentity">
        <p class="mt-1 flex items-start gap-1.5 text-sm text-white">
          <ShieldCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-400" />
          {{ t('home.siteCert.levelBasic') }}
        </p>
        <div v-if="createdAt || lastUsedAt" class="mt-1.5 space-y-0.5 text-sm text-white/85">
          <p>{{ t('home.siteCert.created') }}: {{ fmtDate(createdAt) }}</p>
          <p>{{ t('home.siteCert.lastUsed') }}: {{ fmtDate(lastUsedAt) }}</p>
        </div>
      </template>
      <p v-else class="mt-1 text-sm text-white">{{ t('home.siteCert.firstVisit') }}</p>
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

          <!-- Expiry — red when expired or <30 days. -->
          <p :class="expiryUrgent ? 'text-red-400' : 'text-white/85'">
            <span :class="expiryUrgent ? 'text-red-400/80' : 'text-white/70'">
              {{ t('home.siteCert.tlsExpiry') }}:
            </span>
            <template v-if="tls.expired">{{ t('home.siteCert.tlsExpired') }}</template>
            <template v-else-if="typeof tls.daysToExpiry === 'number'">
              {{ t('home.siteCert.tlsExpiryDays', { days: tls.daysToExpiry }) }}
            </template>
            <template v-else>—</template>
          </p>
        </div>
      </template>

      <p class="mt-1.5 text-xs text-white/50">{{ t('home.siteCert.tlsSnapshotNote') }}</p>
    </div>
  </div>
</template>
