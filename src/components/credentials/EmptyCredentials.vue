<script setup lang="ts">
import { ShieldCheckIcon } from '@heroicons/vue/24/outline'
</script>

<template>
  <div class="ext-empty">
    <div class="rounded-full p-3 mb-3" style="background: var(--ext-bg-surface-hover)">
      <ShieldCheckIcon class="ext-empty__icon" style="color: var(--ext-brand-secondary); margin-bottom: 0" />
    </div>
    <h3 class="ext-empty__title">No Credentials Yet</h3>
    <p class="ext-empty__desc" style="max-width: 260px">
      Verifiable credentials issued to your wallet will appear here.
      They can be shared with verifiers using selective disclosure.
    </p>
  </div>
</template>
