<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TrashIcon } from '@heroicons/vue/24/outline'
import {
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings,
  type SettingsConfig,
  type PinBehavior,
} from '@/utils/settings-config'
import { listPins, unpinSite, type PinRecord } from '@/utils/pin-store'

const { t } = useI18n()

const cfg = ref<SettingsConfig>({ ...DEFAULT_SETTINGS })
const pins = ref<PinRecord[]>([])
const loaded = ref(false)
const justSaved = ref(false)
let saveDebounce: ReturnType<typeof setTimeout> | null = null

const pinModes: PinBehavior[] = ['ask', 'auto', 'never']

onMounted(async () => {
  cfg.value = { ...(await readSettings()) }
  pins.value = await listPins()
  loaded.value = true
})

watch(
  cfg,
  (next) => {
    if (!loaded.value) return
    if (saveDebounce) clearTimeout(saveDebounce)
    saveDebounce = setTimeout(async () => {
      await writeSettings(next)
      justSaved.value = true
      setTimeout(() => (justSaved.value = false), 1500)
    }, 200)
  },
  { deep: true },
)

async function removePin(domain: string): Promise<void> {
  await unpinSite(domain)
  pins.value = await listPins()
}

const sortedPins = computed(() =>
  [...pins.value].sort((a, b) => a.domain.localeCompare(b.domain)),
)
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-6 lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">
    <header class="flex items-end justify-between gap-4">
      <div>
        <h1 class="text-3xl font-semibold tracking-tight text-[#f1f4f8]">{{ t('settingsNav.security') }}</h1>
        <p class="mt-2 text-sm text-[#a8b4c4]">{{ t('security.subtitle') }}</p>
      </div>
      <span
        v-if="justSaved"
        class="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300"
        role="status"
        aria-live="polite"
      >
        {{ t('security.saved') }}
      </span>
    </header>

    <!-- Pin behavior -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="text-lg font-semibold text-[#f1f4f8]">{{ t('security.pinBehavior.title') }}</h2>
      <p class="mt-1 mb-4 text-sm text-[#a8b4c4]">{{ t('security.pinBehavior.description') }}</p>
      <div class="space-y-2">
        <label
          v-for="mode in pinModes"
          :key="mode"
          class="flex cursor-pointer items-start gap-3 rounded-lg border border-[#243044] p-3 hover:border-[#3b82a0]/60"
          :class="cfg.pinBehavior === mode ? 'border-[#3b82a0] bg-[#141e2e]' : ''"
        >
          <input
            v-model="cfg.pinBehavior"
            type="radio"
            :value="mode"
            class="mt-1 size-4 accent-[#3b82a0]"
          />
          <div>
            <div class="text-sm font-medium text-[#f1f4f8]">{{ t(`security.pinBehavior.${mode}.label`) }}</div>
            <div class="text-xs text-[#a8b4c4]">{{ t(`security.pinBehavior.${mode}.desc`) }}</div>
          </div>
        </label>
      </div>
    </section>

    <!-- Notifications -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="mb-1 text-lg font-semibold text-[#f1f4f8]">{{ t('security.notifications.title') }}</h2>
      <p class="mb-4 text-sm text-[#a8b4c4]">{{ t('security.notifications.description') }}</p>
      <label class="flex cursor-pointer items-center justify-between gap-4 py-2">
        <span class="text-sm text-[#f1f4f8]">{{ t('security.notifications.onRed') }}</span>
        <input v-model="cfg.notifyOnRed" type="checkbox" class="size-5 accent-[#3b82a0]" />
      </label>
      <label class="flex cursor-pointer items-center justify-between gap-4 py-2">
        <span class="text-sm text-[#f1f4f8]">{{ t('security.notifications.onRotation') }}</span>
        <input v-model="cfg.notifyOnRotation" type="checkbox" class="size-5 accent-[#3b82a0]" />
      </label>
    </section>

    <!-- Government trust bar -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="mb-1 text-lg font-semibold text-[#f1f4f8]">{{ t('security.trustBar.title') }}</h2>
      <p class="mb-4 text-sm text-[#a8b4c4]">{{ t('security.trustBar.description') }}</p>
      <label class="flex cursor-pointer items-center justify-between gap-4 py-2">
        <span class="text-sm text-[#f1f4f8]">{{ t('security.trustBar.enabled') }}</span>
        <input v-model="cfg.trustBarEnabled" type="checkbox" class="size-5 accent-[#3b82a0]" />
      </label>
    </section>

    <!-- Trusted sites -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="mb-1 text-lg font-semibold text-[#f1f4f8]">{{ t('security.trustedSites.title') }}</h2>
      <p class="mb-4 text-sm text-[#a8b4c4]">{{ t('security.trustedSites.description') }}</p>
      <ul v-if="sortedPins.length" class="divide-y divide-[#243044] rounded-lg border border-[#243044]">
        <li v-for="pin in sortedPins" :key="pin.domain" class="flex items-center justify-between gap-3 px-4 py-3">
          <div class="min-w-0">
            <p class="truncate font-mono text-sm text-[#f1f4f8]">{{ pin.domain }}</p>
            <p class="text-xs text-[#8a97a8]">{{ t('security.trustedSites.addedOn', { date: new Date(pin.addedAt).toLocaleDateString() }) }}</p>
          </div>
          <button
            type="button"
            class="flex items-center gap-1 rounded-md border border-[#243044] px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
            @click="removePin(pin.domain)"
          >
            <TrashIcon class="size-4" />
            {{ t('security.trustedSites.remove') }}
          </button>
        </li>
      </ul>
      <p v-else class="text-sm italic text-[#8a97a8]">{{ t('security.trustedSites.empty') }}</p>
    </section>
  </div>
</template>
