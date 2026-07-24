<script setup lang="ts">
/**
 * SiteHealthPanel — renders locally-analyzed DOM stats for the active tab.
 *
 * Stats are grouped into four areas: Security, Accessibility, Meta, Links.
 * Security group is most prominent (top, with a star/shield visual weight).
 *
 * All analysis ran in the browser, on-device. Nothing is sent anywhere.
 * Nothing is persisted.
 */
import { useI18n } from 'vue-i18n'
import {
  ShieldCheckIcon,
  ShieldExclamationIcon,
  EyeIcon,
  DocumentTextIcon,
  LinkIcon,
  CheckCircleIcon,
  XCircleIcon,
  ExclamationCircleIcon,
  GlobeAltIcon,
  CodeBracketIcon,
} from '@heroicons/vue/24/outline'
import type { SiteHealthResult } from '@/utils/site-health'

const { t } = useI18n()

defineProps<{ health: SiteHealthResult }>()
</script>

<template>
  <!-- Disclosure note — always first -->
  <p class="mb-2 px-1 text-[10px] text-slate-500">
    {{ t('siteHealth.localAnalysisNote') }}
  </p>

  <div class="space-y-3">
    <!-- ── 1. Security hygiene (most prominent) ────────────────────────────── -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <!-- Section header -->
      <div class="mb-2.5 flex items-center gap-2">
        <component
          :is="
            health.security.isHttps &&
            health.security.mixedContentCount === 0 &&
            health.security.unsafeFormCount === 0 &&
            !health.security.passwordOnHttp
              ? ShieldCheckIcon
              : ShieldExclamationIcon
          "
          class="size-4 shrink-0"
          :class="
            health.security.isHttps &&
            health.security.mixedContentCount === 0 &&
            health.security.unsafeFormCount === 0 &&
            !health.security.passwordOnHttp
              ? 'text-emerald-400'
              : 'text-amber-400'
          "
        />
        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {{ t('siteHealth.security.title') }}
        </span>
      </div>

      <ul class="space-y-1.5">
        <!-- HTTPS -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.security.https') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.security.isHttps
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-red-500/15 text-red-300'
            "
          >
            <CheckCircleIcon v-if="health.security.isHttps" class="size-3" />
            <XCircleIcon v-else class="size-3" />
            {{ health.security.isHttps ? t('siteHealth.yes') : t('siteHealth.no') }}
          </span>
        </li>

        <!-- Mixed content (only relevant on HTTPS) -->
        <li v-if="health.security.isHttps" class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.security.mixedContent') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.security.mixedContentCount === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.security.mixedContentCount === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{
              health.security.mixedContentCount === 0
                ? t('siteHealth.none')
                : health.security.mixedContentCount
            }}
          </span>
        </li>

        <!-- Unsafe forms -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.security.unsafeForms') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.security.unsafeFormCount === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-red-500/15 text-red-300'
            "
          >
            <CheckCircleIcon v-if="health.security.unsafeFormCount === 0" class="size-3" />
            <XCircleIcon v-else class="size-3" />
            {{
              health.security.unsafeFormCount === 0 ? t('siteHealth.none') : health.security.unsafeFormCount
            }}
          </span>
        </li>

        <!-- Password on HTTP -->
        <li v-if="health.security.passwordOnHttp" class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.security.passwordOnHttp') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-300"
          >
            <XCircleIcon class="size-3" />
            {{ t('siteHealth.yes') }}
          </span>
        </li>

        <!-- Blank links missing noopener -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.security.blankNoOpener') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.security.blankNoOpenerCount === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.security.blankNoOpenerCount === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{
              health.security.blankNoOpenerCount === 0
                ? t('siteHealth.none')
                : health.security.blankNoOpenerCount
            }}
          </span>
        </li>
      </ul>
    </div>

    <!-- ── 2. Accessibility ────────────────────────────────────────────────── -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div class="mb-2.5 flex items-center gap-2">
        <EyeIcon class="size-4 shrink-0 text-sky-400" />
        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {{ t('siteHealth.a11y.title') }}
        </span>
      </div>

      <ul class="space-y-1.5">
        <!-- Images missing alt -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.a11y.imgAlt') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.a11y.imgMissingAlt === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.a11y.imgMissingAlt === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{ health.a11y.imgMissingAlt === 0 ? t('siteHealth.ok') : `${health.a11y.imgMissingAlt} / ${health.a11y.imgTotal}` }}
          </span>
        </li>

        <!-- Inputs missing label -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.a11y.inputLabels') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.a11y.inputMissingLabel === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.a11y.inputMissingLabel === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{
              health.a11y.inputMissingLabel === 0
                ? t('siteHealth.ok')
                : health.a11y.inputMissingLabel
            }}
          </span>
        </li>

        <!-- HTML lang -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.a11y.htmlLang') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              !health.a11y.missingHtmlLang
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="!health.a11y.missingHtmlLang" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{ !health.a11y.missingHtmlLang ? t('siteHealth.present') : t('siteHealth.missing') }}
          </span>
        </li>

        <!-- H1 count -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.a11y.h1Count') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.a11y.h1Count === 1
                ? 'bg-emerald-500/15 text-emerald-300'
                : health.a11y.h1Count === 0
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-slate-700/60 text-slate-300'
            "
          >
            {{ health.a11y.h1Count }}
          </span>
        </li>

        <!-- Heading levels skipped -->
        <li v-if="health.a11y.headingLevelsSkipped" class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.a11y.headingSkip') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300"
          >
            <ExclamationCircleIcon class="size-3" />
            {{ t('siteHealth.yes') }}
          </span>
        </li>

        <!-- ARIA landmarks -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.a11y.ariaLandmarks') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.a11y.hasAriaLandmarks
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-slate-700/60 text-slate-400'
            "
          >
            <CheckCircleIcon v-if="health.a11y.hasAriaLandmarks" class="size-3" />
            {{ health.a11y.hasAriaLandmarks ? t('siteHealth.present') : t('siteHealth.missing') }}
          </span>
        </li>
      </ul>
    </div>

    <!-- ── 3. Page identity / meta ────────────────────────────────────────── -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div class="mb-2.5 flex items-center gap-2">
        <DocumentTextIcon class="size-4 shrink-0 text-purple-400" />
        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {{ t('siteHealth.meta.title') }}
        </span>
      </div>

      <ul class="space-y-1.5">
        <!-- Title -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.meta.pageTitle') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.meta.hasTitle
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.meta.hasTitle" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{
              health.meta.hasTitle
                ? `${health.meta.titleLength} ${t('siteHealth.meta.chars')}`
                : t('siteHealth.missing')
            }}
          </span>
        </li>

        <!-- Description -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.meta.description') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.meta.hasMetaDescription
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-slate-700/60 text-slate-400'
            "
          >
            <CheckCircleIcon v-if="health.meta.hasMetaDescription" class="size-3" />
            {{
              health.meta.hasMetaDescription ? t('siteHealth.present') : t('siteHealth.missing')
            }}
          </span>
        </li>

        <!-- Canonical -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.meta.canonical') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.meta.hasCanonical
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-slate-700/60 text-slate-400'
            "
          >
            <CheckCircleIcon v-if="health.meta.hasCanonical" class="size-3" />
            {{ health.meta.hasCanonical ? t('siteHealth.present') : t('siteHealth.missing') }}
          </span>
        </li>

        <!-- Favicon -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.meta.favicon') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.meta.hasFavicon
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-slate-700/60 text-slate-400'
            "
          >
            <CheckCircleIcon v-if="health.meta.hasFavicon" class="size-3" />
            {{ health.meta.hasFavicon ? t('siteHealth.present') : t('siteHealth.missing') }}
          </span>
        </li>

        <!-- Open Graph -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.meta.openGraph') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.meta.hasOpenGraph
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-slate-700/60 text-slate-400'
            "
          >
            <CheckCircleIcon v-if="health.meta.hasOpenGraph" class="size-3" />
            {{ health.meta.hasOpenGraph ? t('siteHealth.present') : t('siteHealth.missing') }}
          </span>
        </li>
      </ul>
    </div>

    <!-- ── 4. Links ─────────────────────────────────────────────────────────── -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div class="mb-2.5 flex items-center gap-2">
        <LinkIcon class="size-4 shrink-0 text-indigo-400" />
        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {{ t('siteHealth.links.title') }}
        </span>
      </div>

      <ul class="space-y-1.5">
        <!-- Total -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.links.total') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] font-medium text-slate-300"
          >
            {{ health.links.totalLinks }}
          </span>
        </li>

        <!-- Internal -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.links.internal') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] font-medium text-slate-300"
          >
            {{ health.links.internalLinks }}
          </span>
        </li>

        <!-- External -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.links.external') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] font-medium text-slate-300"
          >
            {{ health.links.externalLinks }}
          </span>
        </li>

        <!-- Insecure -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.links.insecure') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.links.insecureLinks === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.links.insecureLinks === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{
              health.links.insecureLinks === 0 ? t('siteHealth.none') : health.links.insecureLinks
            }}
          </span>
        </li>
      </ul>
    </div>

    <!-- ── 5. Supply Chain (third-party + scripts) ──────────────────────────── -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div class="mb-2.5 flex items-center gap-2">
        <GlobeAltIcon class="size-4 shrink-0 text-orange-400" />
        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {{ t('siteHealth.supplyChain.title') }}
        </span>
      </div>

      <ul class="space-y-1.5">
        <!-- Non-gov scripts on gov host -->
        <li v-if="health.scripts.govHostWithNonGovScripts" class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.supplyChain.nonGovScriptsOnGov') }}</span>
          <span class="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-300">
            <XCircleIcon class="size-3" />
            {{ t('siteHealth.yes') }}
          </span>
        </li>

        <!-- Third-party non-gov script count -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.supplyChain.thirdPartyScripts') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.scripts.externalThirdPartyNonGov === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.scripts.externalThirdPartyNonGov === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{
              health.scripts.externalThirdPartyNonGov === 0
                ? t('siteHealth.none')
                : health.scripts.externalThirdPartyNonGov
            }}
          </span>
        </li>

        <!-- Inline scripts -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.supplyChain.inlineScripts') }}</span>
          <span class="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] font-medium text-slate-300">
            {{ health.scripts.inlineCount }}
          </span>
        </li>

        <!-- Non-gov resources on gov host -->
        <li v-if="health.thirdPartyLinks.govHostWithNonGovResources" class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.supplyChain.nonGovResourcesOnGov') }}</span>
          <span class="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            <ExclamationCircleIcon class="size-3" />
            {{ t('siteHealth.yes') }}
          </span>
        </li>
      </ul>
    </div>

    <!-- ── 6. Page Internals (comments + tech stack) ─────────────────────────── -->
    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div class="mb-2.5 flex items-center gap-2">
        <CodeBracketIcon class="size-4 shrink-0 text-teal-400" />
        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {{ t('siteHealth.pageInternals.title') }}
        </span>
      </div>

      <ul class="space-y-1.5">
        <!-- HTML comments total -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.pageInternals.htmlComments') }}</span>
          <span class="inline-flex items-center gap-1 rounded-full bg-slate-700/60 px-2 py-0.5 text-[11px] font-medium text-slate-300">
            {{ health.comments.total }}
          </span>
        </li>

        <!-- Flagged comments -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.pageInternals.flaggedComments') }}</span>
          <span
            class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="
              health.comments.flaggedCount === 0
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            "
          >
            <CheckCircleIcon v-if="health.comments.flaggedCount === 0" class="size-3" />
            <ExclamationCircleIcon v-else class="size-3" />
            {{ health.comments.flaggedCount === 0 ? t('siteHealth.none') : health.comments.flaggedCount }}
          </span>
        </li>

        <!-- Comment sample (first flagged) -->
        <li v-if="health.comments.samples.length > 0" class="flex flex-col gap-1">
          <span class="text-xs text-slate-400">{{ t('siteHealth.pageInternals.commentSample') }}:</span>
          <span class="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-400 break-all">
            {{ health.comments.samples[0] }}
          </span>
        </li>

        <!-- Tech stack -->
        <li class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.pageInternals.techStack') }}</span>
          <span v-if="health.techStack.detectedPlatforms.length === 0" class="text-[11px] text-slate-500">
            {{ t('siteHealth.pageInternals.noneDetected') }}
          </span>
          <div v-else class="flex flex-wrap gap-1 justify-end">
            <span
              v-for="p in health.techStack.detectedPlatforms"
              :key="p"
              class="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-300"
            >
              {{ p }}
            </span>
          </div>
        </li>

        <!-- Version disclosed -->
        <li v-if="health.techStack.versionDisclosed" class="flex items-center justify-between gap-2">
          <span class="text-xs text-slate-300">{{ t('siteHealth.pageInternals.versionDisclosed') }}</span>
          <span class="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            <ExclamationCircleIcon class="size-3" />
            {{ health.techStack.generatorMetaValue }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
