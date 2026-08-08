<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TrashIcon } from '@heroicons/vue/24/outline'
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings,
  type SettingsConfig,
} from '@/utils/settings-config'
import { readPublicVault } from '@/utils/vault'
import { useWalletStore } from '@/stores/wallet'

const { t } = useI18n()
const wallet = useWalletStore()

const cfg = ref<SettingsConfig>({ ...DEFAULT_SETTINGS })
const loaded = ref(false)
const justSaved = ref(false)
let saveDebounce: ReturnType<typeof setTimeout> | null = null

interface SiteIdentity {
  origin: string
  did: string
  createdAt: string
  lastUsedAt: string
}
const siteIdentities = ref<SiteIdentity[]>([])

// Removal warning + unlock (archiving mutates the encrypted vault).
const pendingRemove = ref<SiteIdentity | null>(null)
const removing = ref(false)
const removeError = ref<string | null>(null)
const needsPass = ref(false)
const passphrase = ref('')

onMounted(async () => {
  const s = await readSettings()
  // Trust behavior is fixed to "always ask" — enforce it, dropping any legacy value.
  if (s.pinBehavior !== 'ask') {
    s.pinBehavior = 'ask'
    await writeSettings(s)
  }
  cfg.value = s
  await loadSiteIdentities()
  loaded.value = true
})

async function loadSiteIdentities(): Promise<void> {
  const pub = await readPublicVault()
  const map = pub?.siteDids ?? {}
  siteIdentities.value = Object.entries(map)
    .map(([origin, e]) => ({ origin, did: e.did, createdAt: e.createdAt, lastUsedAt: e.lastUsedAt }))
    .sort((a, b) => a.origin.localeCompare(b.origin))
}

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

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function askRemove(item: SiteIdentity): void {
  removeError.value = null
  needsPass.value = false
  passphrase.value = ''
  pendingRemove.value = item
}

async function confirmRemove(): Promise<void> {
  if (!pendingRemove.value) return
  removing.value = true
  removeError.value = null
  try {
    if (!wallet.isUnlocked) {
      await wallet.unlock(needsPass.value ? passphrase.value : undefined)
    }
    await wallet.archiveSiteDid(pendingRemove.value.origin)
    await loadSiteIdentities()
    pendingRemove.value = null
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.startsWith('PASSPHRASE_REQUIRED')) {
      needsPass.value = true
      removeError.value = t('security.siteIdentities.unlockNeeded')
    } else {
      removeError.value = t('security.siteIdentities.unlockNeeded')
    }
  } finally {
    removing.value = false
  }
}
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

    <!-- Trust behavior — fixed to always-ask. -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="text-lg font-semibold text-[#f1f4f8]">{{ t('security.pinBehavior.title') }}</h2>
      <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('security.pinBehavior.always') }}</p>
    </section>

    <!-- Idle auto-lock (Story 1.14) -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="mb-1 text-lg font-semibold text-[#f1f4f8]">{{ t('security.autoLock.title') }}</h2>
      <p class="mb-4 text-sm text-[#a8b4c4]">{{ t('security.autoLock.description') }}</p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="minutes in AUTO_LOCK_CHOICES"
          :key="minutes"
          type="button"
          :aria-pressed="cfg.autoLockMinutes === minutes"
          class="rounded-md border px-4 py-2 text-sm transition-colors"
          :class="
            cfg.autoLockMinutes === minutes
              ? 'border-[#4a8ec8] bg-[#4a8ec8]/15 font-semibold text-[#f1f4f8]'
              : 'border-[#243044] text-[#a8b4c4] hover:text-[#f1f4f8]'
          "
          @click="cfg.autoLockMinutes = minutes"
        >
          {{ t('security.autoLock.minutes', { count: minutes }, minutes) }}
        </button>
      </div>
      <p class="mt-3 text-xs text-[#8a97a8]">{{ t('security.autoLock.noNeverNote') }}</p>
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

    <!-- Sites where you have an identity (per-site DIDs) -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="mb-1 text-lg font-semibold text-[#f1f4f8]">{{ t('security.siteIdentities.title') }}</h2>
      <p class="mb-4 text-sm text-[#a8b4c4]">{{ t('security.siteIdentities.description') }}</p>
      <ul v-if="siteIdentities.length" class="divide-y divide-[#243044] rounded-lg border border-[#243044]">
        <li
          v-for="item in siteIdentities"
          :key="item.origin"
          class="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div class="min-w-0">
            <p class="truncate font-mono text-sm text-[#f1f4f8]">{{ hostOf(item.origin) }}</p>
            <p class="truncate text-xs text-[#8a97a8]">{{ item.did }}</p>
            <p class="text-xs text-[#8a97a8]">
              {{ t('security.siteIdentities.created', { date: new Date(item.createdAt).toLocaleDateString() }) }}
            </p>
          </div>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-md border border-[#243044] px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
            @click="askRemove(item)"
          >
            <TrashIcon class="size-4" />
            {{ t('security.siteIdentities.remove') }}
          </button>
        </li>
      </ul>
      <p v-else class="text-sm italic text-[#8a97a8]">{{ t('security.siteIdentities.empty') }}</p>
    </section>

    <!-- Remove warning + unlock -->
    <div
      v-if="pendingRemove"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div class="w-full max-w-md space-y-3 rounded-xl border border-[#243044] bg-[#111a28] p-5">
        <h3 class="text-base font-semibold text-[#f1f4f8]">{{ t('security.siteIdentities.warnTitle') }}</h3>
        <p class="text-sm leading-relaxed text-[#a8b4c4]">
          {{ t('security.siteIdentities.warnBody', { site: hostOf(pendingRemove.origin) }) }}
        </p>

        <input
          v-if="needsPass"
          v-model="passphrase"
          type="password"
          autocomplete="current-password"
          placeholder="Passphrase"
          class="w-full rounded-md border border-[#243044] bg-[#0d1520] px-3 py-2 text-sm text-[#f1f4f8] outline-none focus:border-[#4a8ec8]"
          @keyup.enter="confirmRemove"
        />

        <p v-if="removeError" class="text-sm text-amber-300">{{ removeError }}</p>

        <div class="flex justify-end gap-2 pt-1">
          <button
            type="button"
            class="rounded-md border border-[#243044] px-4 py-2 text-sm text-[#a8b4c4] hover:text-[#f1f4f8]"
            @click="pendingRemove = null"
          >
            {{ t('security.siteIdentities.warnCancel') }}
          </button>
          <button
            type="button"
            :disabled="removing"
            class="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            @click="confirmRemove"
          >
            {{ t('security.siteIdentities.warnConfirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
