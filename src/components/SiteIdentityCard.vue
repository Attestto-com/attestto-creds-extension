<script setup lang="ts">
/**
 * SiteIdentityCard — shared "site certificate" card.
 *
 * Rendered by BOTH the toolbar popup (HomeView) and the approval window, so the
 * two surfaces look like one product. Purely props-driven: each surface reads
 * its data differently (active tab vs. request origin) and passes it in.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ShieldCheckIcon,
  GlobeAltIcon,
  LockClosedIcon,
  LockOpenIcon,
} from '@heroicons/vue/24/outline'

defineProps<{
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
  </div>
</template>
