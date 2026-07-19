<script setup lang="ts">
/**
 * Restore (decrypt) half of self-custody recovery. Reads a backup file, detects
 * its method, collects the matching secret (password OR any 2 of 3 keys), and
 * emits the decrypted vault. It does NOT touch device protection — the parent
 * (LockScreenView) re-protects the device via its normal setup flow, then calls
 * `wallet.restoreFromBackup(vault)`.
 *
 * Strings are hardcoded English to match LockScreenView (that view predates the
 * i18n wiring used by the options page).
 */
import { ref } from 'vue'
import { DocumentArrowUpIcon } from '@heroicons/vue/24/outline'
import type { VaultData } from '@/stores/wallet'
import {
  detectBackupMethod,
  importPassphraseBackup,
  importShamirBackup,
  type BackupMethod,
} from '@/services/vault-backup'

const emit = defineEmits<{ decrypted: [VaultData]; cancel: [] }>()

const fileText = ref<string | null>(null)
const method = ref<BackupMethod | null>(null)
const fileName = ref('')
const passphrase = ref('')
const shareA = ref('')
const shareB = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

async function onFile(e: Event): Promise<void> {
  error.value = null
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    method.value = detectBackupMethod(text) // throws if not an Attestto backup
    fileText.value = text
    fileName.value = file.name
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read backup file'
    fileText.value = null
    method.value = null
  }
}

async function decrypt(): Promise<void> {
  if (!fileText.value || !method.value) return
  error.value = null
  busy.value = true
  try {
    const vault =
      method.value === 'passphrase'
        ? await importPassphraseBackup(fileText.value, passphrase.value)
        : await importShamirBackup(fileText.value, shareA.value.trim(), shareB.value.trim())
    emit('decrypted', vault)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not restore from this backup'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-[280px] space-y-3">
    <p class="text-[11px] leading-relaxed text-amber-200/90">
      Restoring replaces any vault currently on this device.
    </p>

    <!-- File picker -->
    <label
      class="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-slate-700 bg-slate-900 px-3 py-3 text-xs text-slate-300 hover:border-indigo-500"
    >
      <DocumentArrowUpIcon class="h-4 w-4" />
      <span class="truncate">{{ fileName || 'Choose backup file' }}</span>
      <input type="file" accept=".json,application/json" class="hidden" @change="onFile" />
    </label>

    <!-- Password method -->
    <div v-if="method === 'passphrase'" class="space-y-2">
      <label class="block text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Backup password
      </label>
      <input
        v-model="passphrase"
        type="password"
        autocomplete="current-password"
        placeholder="Password you set when backing up"
        class="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
        @keyup.enter="decrypt"
      />
    </div>

    <!-- Shamir method — any 2 of 3 keys -->
    <div v-else-if="method === 'shamir-2of3'" class="space-y-2">
      <label class="block text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Any two recovery keys
      </label>
      <textarea
        v-model="shareA"
        rows="2"
        placeholder="Recovery key (e.g. 1.AbCd…)"
        class="w-full resize-none rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-[11px] text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
      />
      <textarea
        v-model="shareB"
        rows="2"
        placeholder="A different recovery key"
        class="w-full resize-none rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-[11px] text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
      />
    </div>

    <p v-if="error" class="text-[11px] leading-relaxed text-red-400">{{ error }}</p>

    <div class="flex gap-2">
      <button
        type="button"
        class="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        :disabled="busy || !method"
        @click="decrypt"
      >
        {{ busy ? 'Checking…' : 'Continue' }}
      </button>
      <button
        type="button"
        class="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </div>
  </div>
</template>
