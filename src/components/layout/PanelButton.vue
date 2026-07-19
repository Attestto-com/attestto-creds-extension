<script setup lang="ts">
/**
 * PanelButton — the reusable popup action button.
 *
 * Renders an <a> when `href` is set, otherwise a <button>. `variant` sets the
 * primary/secondary hierarchy; `tone` matches the surrounding PopupPanel so the
 * same button reads correctly on both the light welcome and dark trust panels.
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary'
    tone?: 'light' | 'dark'
    href?: string
    target?: string
  }>(),
  { variant: 'primary', tone: 'light' },
)
</script>

<template>
  <component
    :is="href ? 'a' : 'button'"
    :href="href || undefined"
    :target="href ? target : undefined"
    :rel="href && target === '_blank' ? 'noopener noreferrer' : undefined"
    :class="[
      'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold transition-colors',
      variant === 'primary'
        ? tone === 'light'
          ? 'bg-slate-900 text-white shadow-sm hover:bg-slate-800'
          : 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500'
        : tone === 'light'
          ? 'border border-slate-300 bg-white/70 text-slate-800 hover:bg-white'
          : 'border border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-800',
    ]"
  >
    <slot />
  </component>
</template>
