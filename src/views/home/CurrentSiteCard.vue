<script setup lang="ts">
/**
 * Toolbar-popup wrapper: reads the ACTIVE TAB, then renders the shared
 * SiteIdentityCard. Returning-vs-new uses the same trusted-origins signal the
 * approval window uses, so both surfaces agree.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { readPublicVault } from '@/utils/vault'
import { normalizeOrigin } from '@/utils/site-did'
import { isOriginTrusted } from '@/utils/trusted-origins'
import { computeStateForUrl, type TrustState } from '@/utils/tab-state'
import SiteIdentityCard from '@/components/SiteIdentityCard.vue'

const { t } = useI18n()

const loading = ref(true)
const host = ref<string | null>(null)
const siteName = ref<string | null>(null)
const isSecure = ref(false)
const faviconSrc = ref<string | null>(null)
const hasIdentity = ref(false)
const createdAt = ref<string | null>(null)
const lastUsedAt = ref<string | null>(null)
const trustState = ref<TrustState>()

/** Navigate the active tab back, away from a red/impersonation page. */
async function backToSafety(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id == null) return
  try {
    await chrome.tabs.goBack(tab.id)
  } catch {
    // No history to go back to → land on a neutral page instead.
    await chrome.tabs.update(tab.id, { url: 'about:blank' })
  }
}

onMounted(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? null
    if (!url || !/^https?:/.test(url)) {
      host.value = null
      return
    }

    const u = new URL(url)
    host.value = u.host.toLowerCase().replace(/^www\./, '')
    siteName.value = tab?.title?.trim() || null
    isSecure.value = u.protocol === 'https:'
    faviconSrc.value = tab?.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : null
    hasIdentity.value = await isOriginTrusted(u.origin)
    trustState.value = await computeStateForUrl(url)

    // Best-effort created/last-used from the public mirror (may be absent).
    const pub = await readPublicVault()
    const key = normalizeOrigin(url)
    const entry = key && pub?.siteDids ? pub.siteDids[key] : null
    if (entry) {
      createdAt.value = entry.createdAt
      lastUsedAt.value = entry.lastUsedAt
    }
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-white">
    {{ t('home.currentSite.loading') }}
  </div>
  <div v-else-if="!host" class="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-white">
    {{ t('home.currentSite.noSite') }}
  </div>
  <SiteIdentityCard
    v-else
    :host="host"
    :site-name="siteName"
    :is-secure="isSecure"
    :favicon-src="faviconSrc"
    :has-identity="hasIdentity"
    :created-at="createdAt"
    :last-used-at="lastUsedAt"
    :trust-state="trustState"
    @back-to-safety="backToSafety"
  />
</template>
