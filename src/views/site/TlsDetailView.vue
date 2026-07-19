<script setup lang="ts">
/**
 * TLS certificate detail screen (ATT-1006 #14) — the certificate card gets its
 * own popup screen instead of crowding the site card. Reads the active tab's
 * host and looks it up in the bundled CR public-sector snapshot.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowLeftIcon } from '@heroicons/vue/24/outline'
import { lookupTls, snapshotDate, type TlsSnapshotRow } from '@/utils/tls-snapshot'
import TlsCertificateCard from '@/components/TlsCertificateCard.vue'

const router = useRouter()
const { t } = useI18n()

const host = ref<string | null>(null)
const tls = ref<TlsSnapshotRow | null>(null)
const tlsSnapshotDate = ref<string | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? null
    if (url && /^https?:/.test(url)) {
      host.value = new URL(url).host.toLowerCase().replace(/^www\./, '')
      tls.value = await lookupTls(host.value)
      tlsSnapshotDate.value = snapshotDate()
    }
  } finally {
    loading.value = false
  }
})

function goBack(): void {
  router.push('/')
}
</script>

<template>
  <div class="space-y-3">
    <button
      class="flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-white"
      @click="goBack"
    >
      <ArrowLeftIcon class="h-3.5 w-3.5" />
      {{ t('common.back') }}
    </button>

    <div class="flex items-center gap-2 px-1">
      <h2 class="truncate text-sm font-semibold text-white">
        {{ t('home.siteCert.tlsTitle') }}<template v-if="host"> · {{ host }}</template>
      </h2>
    </div>

    <TlsCertificateCard v-if="tls" :tls="tls" :snapshot-date="tlsSnapshotDate" />
    <div
      v-else-if="!loading"
      class="rounded-md border border-slate-800 bg-slate-950/40 p-3 text-center text-xs text-slate-400"
    >
      {{ t('home.siteCert.tlsSnapshotNote') }}
    </div>
  </div>
</template>
