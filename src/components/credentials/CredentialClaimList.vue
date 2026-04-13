<script setup lang="ts">
defineProps<{
  claims: Record<string, unknown>
  depth?: number
}>()

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  return String(value)
}
</script>

<template>
  <div
    style="display: flex; flex-direction: column; gap: 0.25rem"
    :style="(depth ?? 0) > 0 ? { marginLeft: '0.75rem', borderLeft: '1px solid var(--ext-border)', paddingLeft: '0.5rem' } : {}"
  >
    <div v-for="(value, key) in claims" :key="String(key)">
      <template v-if="isObject(value)">
        <p class="ext-detail__label" style="margin-top: 0.25rem">{{ String(key) }}</p>
        <CredentialClaimList :claims="value" :depth="(depth ?? 0) + 1" />
      </template>
      <template v-else>
        <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; padding: 0.125rem 0">
          <span style="font-size: var(--ext-text-2xs); color: var(--ext-text-secondary); flex-shrink: 0">{{ String(key) }}</span>
          <span style="font-size: var(--ext-text-xs); color: var(--ext-text-primary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
            {{ formatValue(value) }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
