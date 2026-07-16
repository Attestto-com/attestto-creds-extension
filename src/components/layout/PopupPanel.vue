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
 *
 * `dense` swaps the airy welcome padding for the tighter padding the
 * information-dense trust surfaces (site identity, approval) need.
 */
withDefaults(defineProps<{ tone?: 'light' | 'dark'; dense?: boolean }>(), {
  tone: 'dark',
  dense: false,
})
</script>

<template>
  <section
    :class="[
      'overflow-hidden shadow-lg ring-1',
      dense ? 'rounded-xl p-3' : 'rounded-2xl p-6',
      tone === 'light'
        ? 'bg-gradient-to-br from-indigo-100 via-purple-50 to-sky-100 text-slate-900 ring-black/5'
        : 'bg-slate-900 text-white ring-slate-700/60',
    ]"
  >
    <slot />
  </section>
</template>
