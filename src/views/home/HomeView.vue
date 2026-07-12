<script setup lang="ts">
/**
 * Popup home — a single read-only card: the active site's domain, logo, and
 * verification grade. Nothing else.
 *
 * Identity is per-site and created on sign-in; trust is decided by signing in
 * (which pins the site). Neither needs a surface here — listing sites or
 * identities would be the cross-site correlation surface the model avoids.
 */
import CurrentSiteCard from './CurrentSiteCard.vue'
</script>

<template>
  <CurrentSiteCard />
</template>
