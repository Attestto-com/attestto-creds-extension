<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CheckCircleIcon } from '@heroicons/vue/24/outline'

const { t } = useI18n()
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-6 lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">
    <header>
      <h1 class="text-3xl font-semibold tracking-tight text-[#f1f4f8]">{{ t('settingsNav.privacy') }}</h1>
      <p class="mt-2 text-sm text-[#a8b4c4]">{{ t('privacy.subtitle') }}</p>
    </header>

    <!-- Sharing -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <div class="flex items-start gap-3">
        <CheckCircleIcon class="size-5 shrink-0 text-emerald-400" />
        <div>
          <h2 class="text-lg font-semibold text-[#f1f4f8]">{{ t('privacy.sharing.title') }}</h2>
          <p class="mt-2 text-sm text-[#f1f4f8]">{{ t('privacy.sharing.body') }}</p>
          <p class="mt-2 text-sm text-[#a8b4c4]">{{ t('privacy.sharing.reminder') }}</p>
        </div>
      </div>
    </section>

    <!-- Telemetry -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <div class="flex items-start gap-3">
        <CheckCircleIcon class="size-5 shrink-0 text-emerald-400" />
        <div>
          <h2 class="text-lg font-semibold text-[#f1f4f8]">{{ t('privacy.telemetry.title') }}</h2>
          <p class="mt-2 text-sm text-[#cfd8e4]">{{ t('privacy.telemetry.body') }}</p>
        </div>
      </div>
    </section>

    <!-- Trust surface honesty -->
    <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5 shadow-sm">
      <h2 class="text-lg font-semibold text-[#f1f4f8]">{{ t('privacy.trustSurface.title') }}</h2>
      <p class="mt-2 text-sm text-[#cfd8e4]">{{ t('privacy.trustSurface.body1') }}</p>
      <p class="mt-2 text-sm text-[#cfd8e4]">{{ t('privacy.trustSurface.body2') }}</p>
    </section>
  </div>
</template>
