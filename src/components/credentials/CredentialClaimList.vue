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
  <div class="space-y-1" :class="{ 'ml-3 border-l border-slate-700 pl-2': (depth ?? 0) > 0 }">
    <div
      v-for="(value, key) in claims"
      :key="String(key)"
    >
      <template v-if="isObject(value)">
        <p class="text-[10px] font-medium text-slate-400 uppercase tracking-wider mt-1">
          {{ String(key) }}
        </p>
        <CredentialClaimList :claims="value" :depth="(depth ?? 0) + 1" />
      </template>
      <template v-else>
        <div class="flex items-baseline justify-between gap-2 py-0.5">
          <span class="text-[10px] text-slate-400 shrink-0">{{ String(key) }}</span>
          <span class="text-[11px] text-slate-200 text-right truncate">
            {{ formatValue(value) }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
