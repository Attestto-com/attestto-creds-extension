<script setup lang="ts">
/**
 * Report-site modal — opt-in community share gated by an unchecked-by-default
 * checkbox per [[feedback_per_event_consent]].
 *
 * Local blocklist always happens. Community share ONLY when the user
 * explicitly checks the box for this specific report. No persistent
 * "share by default" setting anywhere.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { XMarkIcon } from '@heroicons/vue/24/outline'
import { reportSite } from '@/services/report-site'

const props = defineProps<{
  host: string
  collidedWith?: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

const reason = ref('')
const shareWithCommunity = ref(false)
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

async function submit(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  errorMsg.value = null
  try {
    const result = await reportSite({
      host: props.host,
      reason: reason.value.trim() || undefined,
      shareWithCommunity: shareWithCommunity.value,
      collidedWithRegistryHost: props.collidedWith,
    })
    if (shareWithCommunity.value && !result.sharedWithCommunity) {
      errorMsg.value = t('report.shareFailed')
      // Keep the modal open briefly so the user sees what happened, then close.
      setTimeout(() => emit('close'), 1800)
      return
    }
    emit('close')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-3 sm:items-center"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-xl">
      <div class="flex items-start justify-between">
        <h3 class="text-sm font-semibold text-white">{{ t('report.title') }}</h3>
        <button
          type="button"
          class="rounded-md p-1 text-slate-400 hover:text-white"
          @click="emit('close')"
        >
          <XMarkIcon class="size-4" />
        </button>
      </div>

      <p class="mt-2 text-[11px] uppercase tracking-wider text-slate-500">
        {{ t('report.hostLabel') }}
      </p>
      <p class="truncate text-xs text-slate-200">{{ host }}</p>

      <label class="mt-3 block">
        <span class="text-[11px] uppercase tracking-wider text-slate-500">
          {{ t('report.reasonLabel') }}
        </span>
        <input
          v-model="reason"
          type="text"
          :placeholder="t('report.reasonPlaceholder')"
          class="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:border-violet-500 focus:outline-none"
        />
      </label>

      <label class="mt-3 flex items-start gap-2 cursor-pointer">
        <input
          v-model="shareWithCommunity"
          type="checkbox"
          class="mt-0.5 size-4 rounded border-slate-600 bg-slate-950 text-violet-600 focus:ring-violet-500 focus:ring-offset-slate-900"
        />
        <span class="flex-1 text-[11px] leading-relaxed text-slate-300">
          {{ t('report.shareCheckbox') }}
          <span class="mt-1 block text-[10px] text-slate-500">
            {{ t('report.shareHelp') }}
          </span>
        </span>
      </label>

      <p v-if="errorMsg" class="mt-2 text-[11px] text-amber-400">{{ errorMsg }}</p>

      <div class="mt-4 flex gap-2">
        <button
          type="button"
          class="flex-1 rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="flex-1 rounded-md bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60"
          :disabled="submitting"
          @click="submit"
        >
          {{ submitting ? t('report.submitting') : t('report.submit') }}
        </button>
      </div>
    </div>
  </div>
</template>
