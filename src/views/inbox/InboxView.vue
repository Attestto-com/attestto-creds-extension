<script setup lang="ts">
/**
 * Inbox tab (ATT-1006) — everything awaiting the user in one place:
 *   • pending proof requests (need approve / decline)
 *   • prepared presentations pushed from the dashboard (ready to present)
 *
 * Both live in the proof-requests store; this view is a read surface that
 * routes into the existing consent / prepared flows.
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { InboxIcon, BellAlertIcon, PaperAirplaneIcon, ChevronRightIcon } from '@heroicons/vue/24/outline'
import { useProofRequestsStore } from '@/stores/proof-requests'

const router = useRouter()
const { t } = useI18n()
const proofRequests = useProofRequestsStore()

const pending = computed(() => proofRequests.pendingRequests)
const prepared = computed(() => proofRequests.preparedPresentations)
const isEmpty = computed(() => pending.value.length === 0 && prepared.value.length === 0)

onMounted(() => {
  proofRequests.loadFromVault().catch(() => {})
})

function openRequest(id: string): void {
  void router.push(`/consent/${id}`)
}

function openPrepared(): void {
  void router.push('/credentials/prepared')
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2 px-1">
      <InboxIcon class="h-5 w-5 text-indigo-400" />
      <h2 class="text-sm font-semibold text-white">{{ t('inbox.title') }}</h2>
    </div>

    <!-- Empty -->
    <div
      v-if="isEmpty"
      class="rounded-lg border border-slate-700 bg-slate-900 p-4 text-center text-xs text-slate-400"
    >
      {{ t('inbox.empty') }}
    </div>

    <!-- Pending proof requests -->
    <div v-if="pending.length" class="space-y-2">
      <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {{ t('inbox.pendingTitle') }}
      </p>
      <button
        v-for="req in pending"
        :key="req.id"
        type="button"
        class="flex w-full items-center gap-2 rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-left transition-colors hover:bg-amber-950/50"
        @click="openRequest(req.id)"
      >
        <BellAlertIcon class="h-4 w-4 shrink-0 text-amber-400" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-medium text-white">{{ req.requesterName }}</p>
          <p class="truncate text-[11px] text-slate-400">{{ req.purpose }}</p>
        </div>
        <ChevronRightIcon class="h-4 w-4 shrink-0 text-slate-500" />
      </button>
    </div>

    <!-- Prepared presentations -->
    <div v-if="prepared.length" class="space-y-2">
      <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {{ t('inbox.preparedTitle') }}
      </p>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left transition-colors hover:bg-slate-800"
        @click="openPrepared"
      >
        <PaperAirplaneIcon class="h-4 w-4 shrink-0 text-indigo-400" />
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-white">
            {{ t('inbox.preparedCount', { count: prepared.length }, prepared.length) }}
          </p>
          <p class="text-[11px] text-slate-400">{{ t('inbox.preparedHint') }}</p>
        </div>
        <ChevronRightIcon class="h-4 w-4 shrink-0 text-slate-500" />
      </button>
    </div>
  </div>
</template>
