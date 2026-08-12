<script setup lang="ts">
/**
 * Site Profile — full detail view for the current active tab's host.
 *
 * Opened when the user taps the site card on the Home (Site) tab. Composes
 * every client-side signal the extension already has about the site:
 *   - Host, HTTPS state, favicon.
 *   - Trust-registry match (institution name / category) if any.
 *   - Gov-host status (.go.cr / .fi.cr / etc.).
 *   - Brand label + homograph/brand-squat warning.
 *   - TOFU pin state (user has explicitly trusted this site).
 *   - Bundled TLS certificate snapshot if the host is in it.
 *     If NOT in the snapshot: honest empty state + live scan on user request.
 *   - Site health stats (DOM analysis, in-browser only, on demand).
 *
 * Read-only display only. No new storage writes.
 * No content-script injection — popup only per doctrine.
 *
 * Scan mechanism:
 *   "Scan this site" sends CERT_SCAN_REQUEST to the background SW (which
 *   calls the Attestto backend GET /scan?host=...). Only the hostname is
 *   forwarded — never the full URL, path, or any user data.
 *   Fires only on explicit user click (consent required per policy).
 *
 * Site health mechanism:
 *   Uses chrome.scripting.executeScript (already in manifest) to inject
 *   analyzeSiteHealth as a serialized inline function into the active tab
 *   and immediately return the result. Runs only when the user opens this
 *   profile view — never in the background. No new permissions required
 *   (activeTab + scripting are already declared in wxt.config.ts).
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftIcon,
  GlobeAltIcon,
  LockClosedIcon,
  LockOpenIcon,
  ShieldCheckIcon,
  BuildingLibraryIcon,
  MapPinIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
} from '@heroicons/vue/24/outline'
import { lookupTls, snapshotDate, type TlsSnapshotRow } from '@/utils/tls-snapshot'
import { lookupHost } from '@/utils/trust-registry'
import { isGovHost, GOV_TLDS } from '@/utils/gov-host'
import { homographState, type HomographVerdict } from '@/utils/homograph'
import { isPinned } from '@/utils/pin-store'
import { analyzeSiteHealth, type SiteHealthResult } from '@/utils/site-health'
import type { CertScanResult } from '@/api/backend-client'
import TlsCertificateCard from '@/components/TlsCertificateCard.vue'
import SiteHealthPanel from '@/components/SiteHealthPanel.vue'
import PopupPanel from '@/components/layout/PopupPanel.vue'

const router = useRouter()
const { t } = useI18n()

// ── resolved data ─────────────────────────────────────────────────────────────
const loading = ref(true)
const host = ref<string | null>(null)
const isSecure = ref(false)
const faviconSrc = ref<string | null>(null)
const faviconOk = ref(true)

const institutionName = ref<string | null>(null)
const institutionCategory = ref<string | null>(null)
const isGov = ref(false)
const brandLabel = ref<string | null>(null)
const homograph = ref<HomographVerdict>(null)
const pinned = ref(false)

const tls = ref<TlsSnapshotRow | null>(null)
const tlsSnapDate = ref<string | null>(null)

// ── live scan (backend, on user click) ────────────────────────────────────────
const scanLoading = ref(false)
const scanResult = ref<CertScanResult | null>(null)
const scanError = ref(false)

async function runLiveScan(): Promise<void> {
  if (!host.value || scanLoading.value) return
  scanLoading.value = true
  scanError.value = false
  scanResult.value = null
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CERT_SCAN_REQUEST',
      payload: { hostname: host.value },
    })
    if (response?.ok === false) {
      scanError.value = true
    } else {
      scanResult.value = response
    }
  } catch {
    scanError.value = true
  } finally {
    scanLoading.value = false
  }
}

// ── site health ───────────────────────────────────────────────────────────────
const healthLoading = ref(false)
const healthResult = ref<SiteHealthResult | null>(null)
const healthError = ref(false)
let activeTabId: number | null = null

// ── lifecycle ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? null
    if (!url || !/^https?:/.test(url)) return

    activeTabId = tab?.id ?? null

    const u = new URL(url)
    host.value = u.host.toLowerCase().replace(/^www\./, '')
    isSecure.value = u.protocol === 'https:'
    faviconSrc.value =
      tab?.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : null

    const [registryEntry, govResult, homographResult, pinnedResult, tlsResult] = await Promise.all([
      lookupHost(host.value),
      Promise.resolve(isGovHost(host.value)),
      homographState(host.value),
      isPinned(host.value),
      lookupTls(host.value),
    ])

    institutionName.value = registryEntry?.name ?? null
    institutionCategory.value = registryEntry?.category ?? null
    isGov.value = govResult
    homograph.value = homographResult
    pinned.value = pinnedResult
    tls.value = tlsResult
    tlsSnapDate.value = snapshotDate()

    // Brand label only meaningful for non-registry hosts; registry match is
    // already surfaced via institutionName.
    if (!registryEntry && host.value) {
      const { brandLabelFromHost } = await import('@/utils/trust-registry')
      brandLabel.value = brandLabelFromHost(host.value)
    }

    // Kick off site health analysis immediately after the tab is known.
    // Runs on explicit user action (opening the profile), not in background.
    void runHealthAnalysis(activeTabId)
  } finally {
    loading.value = false
  }
})

async function runHealthAnalysis(tabId: number | null): Promise<void> {
  if (tabId === null) return
  healthLoading.value = true
  healthError.value = false
  try {
    // Serialize analyzeSiteHealth as an inline function injected into the active
    // tab. No closure captures — the gov-TLD list is threaded in as a DATA arg from
    // the single source (Story 1.12), never re-inlined in the serialized function.
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: analyzeSiteHealth,
      args: [[...GOV_TLDS]],
      world: 'MAIN',
    })
    const value = results?.[0]?.result ?? null
    healthResult.value = value
    if (!healthResult.value) healthError.value = true
  } catch {
    healthError.value = true
  } finally {
    healthLoading.value = false
  }
}

function goBack(): void {
  void router.push('/')
}
</script>

<template>
  <div class="space-y-3">
    <!-- ── Back control ─────────────────────────────────────────────────── -->
    <button
      class="flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-white"
      @click="goBack"
    >
      <ArrowLeftIcon class="h-3.5 w-3.5" />
      {{ t('common.back') }}
    </button>

    <!-- ── Loading ─────────────────────────────────────────────────────── -->
    <div
      v-if="loading"
      class="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-white"
    >
      {{ t('home.currentSite.loading') }}
    </div>

    <!-- ── No active HTTP/S tab ─────────────────────────────────────────── -->
    <div
      v-else-if="!host"
      class="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-white"
    >
      {{ t('home.currentSite.noSite') }}
    </div>

    <template v-else>
      <!-- 1. Identity card ─────────────────────────────────────────────── -->
      <PopupPanel tone="dark" dense :danger="!isSecure">
        <div class="space-y-3">
          <!-- Favicon · host · secure badge -->
          <div class="flex items-center gap-3">
            <div
              class="flex size-14 shrink-0 items-center justify-center rounded-full bg-slate-800 ring-1 ring-slate-700"
            >
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
              <!-- Institution title (registry match) or plain host -->
              <p class="truncate text-base font-semibold text-white">
                {{ institutionName || host }}
              </p>
              <p class="mt-0.5 flex items-center gap-1.5 text-sm text-white/70">
                <component
                  :is="isSecure ? LockClosedIcon : LockOpenIcon"
                  class="size-5 shrink-0"
                  :class="isSecure ? 'text-emerald-400' : 'text-red-400'"
                />
                <span class="truncate">{{ isSecure ? 'https://' : 'http://' }}{{ host }}</span>
              </p>
            </div>
          </div>

          <!-- Trust verdict row -->
          <div class="flex flex-wrap gap-2">
            <!-- Pinned -->
            <span
              v-if="pinned"
              class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/30"
            >
              <MapPinIcon class="size-3.5" />
              {{ t('siteProfile.pinned') }}
            </span>

            <!-- Registry-verified -->
            <span
              v-if="institutionName"
              class="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300 ring-1 ring-sky-500/30"
            >
              <ShieldCheckIcon class="size-3.5" />
              {{ t('siteProfile.registryVerified') }}
            </span>

            <!-- Government host -->
            <span
              v-if="isGov"
              class="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2.5 py-1 text-xs font-semibold text-indigo-300 ring-1 ring-indigo-500/30"
            >
              <BuildingLibraryIcon class="size-3.5" />
              {{ t('siteProfile.govHost') }}
            </span>

            <!-- No signals — neutral -->
            <span
              v-if="!pinned && !institutionName && homograph === null"
              class="inline-flex items-center gap-1 rounded-full bg-slate-700/50 px-2.5 py-1 text-xs font-semibold text-slate-400 ring-1 ring-slate-600/40"
            >
              {{ t('siteProfile.notYetEvaluated') }}
            </span>
          </div>

          <!-- Homograph / brand-squat warning -->
          <div
            v-if="homograph"
            class="flex items-start gap-2 rounded-md border p-2.5"
            :class="
              homograph === 'red'
                ? 'border-red-500/40 bg-red-500/10'
                : 'border-amber-500/40 bg-amber-500/10'
            "
          >
            <ExclamationTriangleIcon
              class="mt-0.5 size-4 shrink-0"
              :class="homograph === 'red' ? 'text-red-400' : 'text-amber-400'"
            />
            <div>
              <p
                class="text-sm font-semibold"
                :class="homograph === 'red' ? 'text-red-300' : 'text-amber-300'"
              >
                {{
                  homograph === 'red'
                    ? t('siteProfile.brandSquatWarning')
                    : t('siteProfile.punycodeWarning')
                }}
              </p>
              <p class="mt-0.5 text-xs text-white/60">
                {{
                  homograph === 'red'
                    ? t('siteProfile.brandSquatDetail')
                    : t('siteProfile.punycodeDetail')
                }}
              </p>
            </div>
          </div>

          <!-- Institution detail (registry) -->
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
                {{ institutionName
                }}<template v-if="institutionCategory"> · {{ institutionCategory }}</template>
              </span>
            </p>
          </div>
        </div>
      </PopupPanel>

      <!-- 2. TLS certificate ───────────────────────────────────────────── -->
      <div>
        <p class="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {{ t('home.siteCert.tlsTitle') }}
        </p>

        <!-- In snapshot: full card -->
        <TlsCertificateCard
          v-if="tls"
          :tls="tls"
          :snapshot-date="tlsSnapDate"
        />

        <!-- Not in snapshot: honest empty state + live scan on user click -->
        <div
          v-else
          class="rounded-md border border-slate-800 bg-slate-950/40 p-3"
        >
          <!-- Scan result: cert details -->
          <template v-if="scanResult">
            <!-- Expired warning -->
            <div
              v-if="scanResult.expired"
              class="mb-2 flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-300"
            >
              <ExclamationTriangleIcon class="size-3.5 shrink-0" />
              {{ t('siteProfile.scanExpired') }}
            </div>
            <!-- Cert fields -->
            <dl class="space-y-1.5 text-xs">
              <div v-if="scanResult.ca" class="flex justify-between gap-2">
                <dt class="text-slate-400">{{ t('siteProfile.scanCa') }}</dt>
                <dd class="text-right font-medium text-white">{{ scanResult.ca }}</dd>
              </div>
              <div v-if="scanResult.validationTier" class="flex justify-between gap-2">
                <dt class="text-slate-400">{{ t('siteProfile.scanValidation') }}</dt>
                <dd class="text-right font-medium text-white">{{ scanResult.validationTier }}</dd>
              </div>
              <div v-if="scanResult.daysToExpiry !== undefined" class="flex justify-between gap-2">
                <dt class="text-slate-400">{{ t('siteProfile.scanExpiry') }}</dt>
                <dd
                  class="text-right font-medium"
                  :class="scanResult.expired ? 'text-red-400' : 'text-white'"
                >
                  {{ t('siteProfile.scanExpiryDays', { days: scanResult.daysToExpiry }) }}
                </dd>
              </div>
            </dl>
          </template>

          <!-- Scan error -->
          <div
            v-else-if="scanError"
            class="flex items-center justify-center gap-1.5 py-1 text-xs text-red-400"
          >
            <ExclamationTriangleIcon class="size-3.5 shrink-0" />
            {{ t('siteProfile.scanError') }}
          </div>

          <!-- Pre-scan empty state -->
          <template v-else>
            <div class="text-center">
              <MagnifyingGlassIcon class="mx-auto mb-1.5 size-6 text-slate-500" />
              <p class="text-sm font-medium text-white/70">
                {{ t('siteProfile.tlsNoSnapshot') }}
              </p>
              <p class="mt-0.5 text-xs text-slate-500">
                {{ t('siteProfile.tlsNoSnapshotDetail') }}
              </p>
            </div>
          </template>

          <!-- Scan button — fires only on click (per-event consent) -->
          <button
            v-if="!scanResult"
            type="button"
            :disabled="scanLoading"
            class="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-700/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            @click="runLiveScan"
          >
            <MagnifyingGlassIcon class="size-3.5" />
            {{ scanLoading ? t('siteProfile.scanScanning') : t('siteProfile.scanThisSite') }}
          </button>
        </div>
      </div>

      <!-- 3. Site health ──────────────────────────────────────────────── -->
      <div>
        <p class="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {{ t('siteHealth.sectionTitle') }}
        </p>

        <!-- Analyzing -->
        <div
          v-if="healthLoading"
          class="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-400"
        >
          {{ t('siteHealth.analyzing') }}
        </div>

        <!-- Error state -->
        <div
          v-else-if="healthError"
          class="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-500"
        >
          {{ t('siteHealth.analyzeError') }}
        </div>

        <!-- Results -->
        <SiteHealthPanel
          v-else-if="healthResult"
          :health="healthResult"
        />
      </div>
    </template>
  </div>
</template>
