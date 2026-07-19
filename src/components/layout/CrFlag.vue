<script setup lang="ts">
/**
 * Costa Rica flag chip — the same CSS gradient the on-page trust bar uses
 * (ATT-1006 #4). Purely decorative; shown next to the site status for CR hosts.
 */
</script>

<template>
  <span class="cr-flag" role="img" aria-label="Costa Rica" />
</template>

<style scoped>
.cr-flag {
  display: inline-block;
  width: 18px;
  height: 12px;
  border-radius: 2px;
  flex: 0 0 auto;
  background: linear-gradient(
    #002b7f 0 16.6%,
    #fff 16.6% 33.3%,
    #ce1126 33.3% 66.6%,
    #fff 66.6% 83.3%,
    #002b7f 83.3% 100%
  );
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
}
</style>
