<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldCheckIcon, FingerPrintIcon, LockClosedIcon, EyeSlashIcon, ArrowRightIcon } from '@heroicons/vue/24/outline'
import { listPins, type PinRecord } from '@/utils/pin-store'
import { useWalletStore } from '@/stores/wallet'

defineEmits<{ goto: [tab: 'overview' | 'security' | 'privacy'] }>()

const { t } = useI18n()
const wallet = useWalletStore()
const pins = ref<PinRecord[]>([])

const PLATFORM_URL = 'https://app.attestto.com'

const hasIdentity = computed(() => wallet.linkedIdentities.length > 0)
const trustedCount = computed(() => pins.value.length)

onMounted(async () => {
  await wallet.loadPublicData()
  try {
    pins.value = await listPins()
  } catch {
    pins.value = []
  }
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-6 lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">
    <header>
      <h1 class="text-3xl font-semibold tracking-tight text-slate-900">{{ t('overview.title') }}</h1>
      <p class="mt-2 text-sm text-slate-600">{{ t('overview.subtitle') }}</p>
    </header>

    <!-- Anti-phishing card -->
    <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex items-start gap-4">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <ShieldCheckIcon class="size-5 text-emerald-700" />
        </div>
        <div class="flex-1">
          <h2 class="text-base font-semibold text-slate-900">{{ t('overview.protection.title') }}</h2>
          <p class="mt-1 text-sm text-slate-600">{{ t('overview.protection.body') }}</p>
          <p class="mt-3 text-xs text-slate-500">{{ t('overview.protection.trustedCount', { n: trustedCount }, trustedCount) }}</p>
          <button
            type="button"
            class="mt-3 inline-flex items-center gap-1 text-sm font-medium text-cyan-700 hover:text-cyan-900"
            @click="$emit('goto', 'security')"
          >
            {{ t('overview.protection.manage') }}
            <ArrowRightIcon class="size-4" />
          </button>
        </div>
      </div>
    </section>

    <!-- Identity card -->
    <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex items-start gap-4">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-violet-100">
          <FingerPrintIcon class="size-5 text-violet-700" />
        </div>
        <div class="flex-1">
          <h2 class="text-base font-semibold text-slate-900">{{ t('overview.identity.title') }}</h2>
          <template v-if="hasIdentity">
            <p class="mt-1 text-sm text-slate-600">{{ t('overview.identity.activeBody') }}</p>
            <ul class="mt-2 space-y-1">
              <li v-for="i in wallet.linkedIdentities" :key="i.did" class="text-xs font-mono text-slate-700">{{ i.label }}</li>
            </ul>
          </template>
          <template v-else>
            <p class="mt-1 text-sm text-slate-600">{{ t('overview.identity.upgradeBody') }}</p>
            <a
              :href="`${PLATFORM_URL}/onboarding?src=extension`"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-3 inline-flex items-center gap-1 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
            >
              {{ t('overview.identity.setup') }}
              <ArrowRightIcon class="size-4" />
            </a>
            <p class="mt-2 text-xs text-slate-500">
              {{ t('overview.identity.alreadyHave') }}
              <a
                :href="`${PLATFORM_URL}/lock?src=extension`"
                target="_blank"
                rel="noopener noreferrer"
                class="text-violet-700 hover:text-violet-900"
              >{{ t('overview.identity.signIn') }}</a>
            </p>
          </template>
        </div>
      </div>
    </section>

    <!-- Quick links to sub-pages -->
    <section class="grid gap-3 sm:grid-cols-2">
      <button
        type="button"
        class="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-cyan-400 hover:bg-cyan-50/40"
        @click="$emit('goto', 'security')"
      >
        <LockClosedIcon class="size-5 text-slate-500" />
        <div>
          <p class="text-sm font-medium text-slate-900">{{ t('settingsNav.security') }}</p>
          <p class="mt-0.5 text-xs text-slate-600">{{ t('overview.cards.security') }}</p>
        </div>
      </button>
      <button
        type="button"
        class="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-cyan-400 hover:bg-cyan-50/40"
        @click="$emit('goto', 'privacy')"
      >
        <EyeSlashIcon class="size-5 text-slate-500" />
        <div>
          <p class="text-sm font-medium text-slate-900">{{ t('settingsNav.privacy') }}</p>
          <p class="mt-0.5 text-xs text-slate-600">{{ t('overview.cards.privacy') }}</p>
        </div>
      </button>
    </section>
  </div>
</template>
