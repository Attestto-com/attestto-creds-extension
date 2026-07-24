<script setup lang="ts">
/**
 * Mobile-app style bottom navigation for the popup (ATT-1006).
 * Replaces the old gear-only header nav with four persistent tabs:
 * Site · Accounts · Credentials · Inbox.
 *
 * The active tab is derived from the current route so deep sub-pages
 * (identity detail, present, consent) still light up their parent tab.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  GlobeAltIcon,
  FingerPrintIcon,
  IdentificationIcon,
  InboxIcon,
} from '@heroicons/vue/24/outline'
import { useProofRequestsStore } from '@/stores/proof-requests'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const proofRequests = useProofRequestsStore()

interface Tab {
  key: string
  to: string
  labelKey: string
  icon: typeof GlobeAltIcon
  /** Route names that count as "inside" this tab. */
  match: string[]
}

const TABS: Tab[] = [
  { key: 'site', to: '/', labelKey: 'bottomNav.site', icon: GlobeAltIcon, match: ['home', 'tls-detail', 'site-profile'] },
  {
    key: 'accounts',
    to: '/identities',
    labelKey: 'bottomNav.accounts',
    icon: FingerPrintIcon,
    match: ['identity-list', 'identity-detail'],
  },
  {
    key: 'credentials',
    to: '/credentials',
    labelKey: 'bottomNav.credentials',
    icon: IdentificationIcon,
    match: ['credentials', 'present-credential'],
  },
  {
    key: 'inbox',
    to: '/inbox',
    labelKey: 'bottomNav.inbox',
    icon: InboxIcon,
    match: ['inbox', 'prepared-presentations', 'proof-consent', 'chapi-consent'],
  },
]

/** Count of items awaiting the user in the Inbox (pending + prepared). */
const inboxCount = computed(
  () => proofRequests.pendingRequests.length + proofRequests.preparedPresentations.length,
)

function isActive(tab: Tab): boolean {
  return tab.match.includes(String(route.name ?? ''))
}

function go(tab: Tab): void {
  if (isActive(tab)) return
  router.push(tab.to)
}
</script>

<template>
  <nav
    class="grid grid-cols-4 border-t border-slate-800/40 bg-black/20 backdrop-blur-sm"
    aria-label="Primary"
  >
    <button
      v-for="tab in TABS"
      :key="tab.key"
      type="button"
      class="relative flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors"
      :class="isActive(tab) ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'"
      :aria-current="isActive(tab) ? 'page' : undefined"
      @click="go(tab)"
    >
      <span class="relative">
        <component :is="tab.icon" class="h-6 w-6" />
        <span
          v-if="tab.key === 'inbox' && inboxCount > 0"
          class="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-500 px-1 text-[9px] font-bold text-white"
        >{{ inboxCount > 9 ? '9+' : inboxCount }}</span>
      </span>
      {{ t(tab.labelKey) }}
    </button>
  </nav>
</template>
