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
  <!-- Mobile-app shell on the full settings page too (ATT-1006 #22): a centered
       column with a bottom tab bar instead of a desktop sidebar, so the popup
       and the full page feel like one product. -->
  <div class="flex min-h-screen flex-col bg-[#0d1520]">
    <header class="border-b border-[#243044] bg-[#111a28] px-5 py-4 text-center">
      <p class="text-base font-semibold text-[#f1f4f8]">Attestto ID</p>
      <p class="mt-0.5 text-[11px] text-[#a8b4c4]">{{ t('settingsNav.subtitle') }}</p>
    </header>

    <!-- Content — extra bottom padding clears the fixed tab bar. -->
    <main class="mx-auto w-full max-w-3xl flex-1 px-6 py-8 pb-24">
      <OverviewView v-if="active === 'overview'" @goto="goto" />
      <SecurityView v-else-if="active === 'security'" />
      <PrivacyView v-else-if="active === 'privacy'" />
    </main>

    <!-- Bottom tab bar -->
    <nav
      class="fixed inset-x-0 bottom-0 z-10 border-t border-[#243044] bg-[#111a28]/95 backdrop-blur"
      aria-label="Settings sections"
    >
      <div class="mx-auto grid max-w-md grid-cols-3">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors"
          :class="active === tab.key ? 'text-[#4a8ec8]' : 'text-[#8a97a8] hover:text-[#f1f4f8]'"
          :aria-current="active === tab.key ? 'page' : undefined"
          @click="selectTab(tab.key)"
        >
          <component :is="tab.icon" class="size-6" />
          {{ t(tab.labelKey) }}
        </button>
      </div>
    </nav>
  </div>
</template>
