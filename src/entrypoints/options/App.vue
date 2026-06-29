<script setup lang="ts">
/**
 * Settings shell — sidebar nav + sub-views (ATT-725 + ATT-726).
 *
 * Tab is chosen by `?tab=` URL query (LastPass-style deep-linkable URLs).
 * Default tab is Overview.
 *
 *   options.html              → Overview
 *   options.html?tab=security → Security
 *   options.html?tab=privacy  → Privacy
 *
 * No multi-step onboarding tour — first install lands here directly (per
 * Eduardo's wireframes 2026-06-29).
 */
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldCheckIcon, LockClosedIcon, EyeSlashIcon } from '@heroicons/vue/24/outline'
import OverviewView from './views/OverviewView.vue'
import SecurityView from './views/SecurityView.vue'
import PrivacyView from './views/PrivacyView.vue'

const { t, locale } = useI18n()

type Tab = 'overview' | 'security' | 'privacy'

const TABS: Array<{ key: Tab; labelKey: string; icon: typeof ShieldCheckIcon }> = [
  { key: 'overview', labelKey: 'settingsNav.overview', icon: ShieldCheckIcon },
  { key: 'security', labelKey: 'settingsNav.security', icon: LockClosedIcon },
  { key: 'privacy',  labelKey: 'settingsNav.privacy',  icon: EyeSlashIcon },
]

const active = ref<Tab>(currentTab())

function currentTab(): Tab {
  const q = new URLSearchParams(window.location.search).get('tab')
  if (q === 'security' || q === 'privacy') return q
  return 'overview'
}

function selectTab(t: Tab): void {
  active.value = t
  const url = new URL(window.location.href)
  if (t === 'overview') url.searchParams.delete('tab')
  else url.searchParams.set('tab', t)
  window.history.pushState({}, '', url.toString())
}

onMounted(async () => {
  const localePref = await chrome.storage.local.get('attestto_ext_locale')
  if (localePref['attestto_ext_locale'] === 'es') locale.value = 'es'
  window.addEventListener('popstate', () => {
    active.value = currentTab()
  })
})

// Allow children to switch tabs (e.g., Overview links into Security)
function goto(tab: Tab): void {
  selectTab(tab)
}

watch(active, () => {
  // Scroll the content area to the top when tabs change so the user always
  // lands at the section header, not where the previous tab was scrolled to.
  document.querySelector('main')?.scrollTo({ top: 0 })
})
</script>

<template>
  <div class="flex min-h-screen bg-slate-50">
    <!-- Sidebar -->
    <aside class="w-60 shrink-0 border-r border-slate-200 bg-white">
      <div class="border-b border-slate-200 px-5 py-4">
        <p class="text-base font-semibold text-slate-900">Attestto ID</p>
        <p class="mt-0.5 text-[11px] text-slate-500">{{ t('settingsNav.subtitle') }}</p>
      </div>
      <nav class="p-2">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition"
          :class="active === tab.key
            ? 'bg-cyan-50 text-cyan-800 font-medium'
            : 'text-slate-700 hover:bg-slate-100'"
          @click="selectTab(tab.key)"
        >
          <component :is="tab.icon" class="size-4 shrink-0" />
          <span>{{ t(tab.labelKey) }}</span>
        </button>
      </nav>
    </aside>

    <!-- Content -->
    <main class="flex-1 overflow-y-auto px-10 py-10">
      <OverviewView v-if="active === 'overview'" @goto="goto" />
      <SecurityView v-else-if="active === 'security'" />
      <PrivacyView v-else-if="active === 'privacy'" />
    </main>
  </div>
</template>
