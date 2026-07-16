<script setup lang="ts">
/**
 * PopupPanel — the reusable popup surface shell.
 *
 * Every popup/approval card composes this so width, radius, elevation and
 * padding stay identical across surfaces. `tone` is the only knob:
 *   - 'light' → the warm onboarding/welcome moment (gradient, dark text)
 *   - 'dark'  → focused trust/security surfaces (site identity, approval)
 *
 * This is how the popup stays consistent by construction instead of per-view.
 */
withDefaults(defineProps<{ tone?: 'light' | 'dark' }>(), { tone: 'dark' })
</script>

<template>
  <section
    :class="[
      'overflow-hidden rounded-2xl p-6 shadow-lg ring-1',
      tone === 'light'
        ? 'bg-gradient-to-br from-indigo-100 via-purple-50 to-sky-100 text-slate-900 ring-black/5'
        : 'bg-slate-900 text-white ring-white/5',
    ]"
  >
    <slot />
  </section>
</template>
