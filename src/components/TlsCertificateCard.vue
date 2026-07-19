<script setup lang="ts">
/**
 * TLS certificate card (ATT-1006 #14) — the bundled CR public-sector snapshot
 * view for one host. Extracted from SiteIdentityCard so it can render both
 * inline (approval window) and on its own screen (popup TLS detail).
 *
 * MV3 can't read the live served cert, so this shows what our scanner recorded,
 * keyed by host.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DocumentCheckIcon, LockOpenIcon } from '@heroicons/vue/24/outline'
import type { TlsSnapshotRow } from '@/utils/tls-snapshot'

const props = defineProps<{
  tls: TlsSnapshotRow
  snapshotDate?: string | null
}>()

const { t } = useI18n()

/** Tailwind classes for the DV/OV/EV validation-tier chip. */
const tierChipClass = computed(() => {
  switch (props.tls.validationTier) {
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

const expirySeverity = computed<'expired' | 'soon' | 'ok'>(() => {
  const c = props.tls
  if (c.expired || (typeof c.daysToExpiry === 'number' && c.daysToExpiry < 0)) return 'expired'
  if (typeof c.daysToExpiry === 'number' && c.daysToExpiry < 30) return 'soon'
  return 'ok'
})

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

const expiryAbsolute = computed<string | null>(() => {
  const iso = props.tls.validTo
  if (!iso) return null
  const dt = new Date(iso)
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10)
})
</script>

<template>
  <div class="rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
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

        <p>
          <span class="text-white/70">{{ t('home.siteCert.tlsTier') }}:</span>
          {{ tls.isFreeCA ? t('home.siteCert.tlsFree') : t('home.siteCert.tlsPaid') }}
        </p>

        <p :class="expiryTextClass">
          <span :class="expiryLabelClass">{{ t('home.siteCert.tlsExpiry') }}:</span>
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
        snapshotDate
          ? t('home.siteCert.tlsSnapshotNoteDated', { date: snapshotDate })
          : t('home.siteCert.tlsSnapshotNote')
      }}
    </p>
  </div>
</template>
