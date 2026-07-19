<script setup lang="ts">
/**
 * Backup & recovery (self-custody export).
 *
 * Two offline, self-custody export paths, both built on the tested
 * `vault-backup` service:
 *   - Password-protected file (Argon2id + AES-256-GCM).
 *   - Split recovery: one file + three 2-of-3 Shamir keys.
 *
 * Reading the FULL vault (incl. private keys) needs an active session key, so
 * the view gates behind unlock. Restore lives on the lock screen, not here.
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { LockClosedIcon, DocumentArrowDownIcon } from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import { readVault } from '@/utils/vault'
import { exportPassphraseBackup } from '@/services/vault-backup'

const { t } = useI18n()
const wallet = useWalletStore()

const unlocked = ref(false)
const needsPassphrase = ref(false)
const unlockPass = ref('')
const unlockError = ref('')

const pass = ref('')
const passConfirm = ref('')
const passError = ref('')
const passDone = ref(false)

const busy = ref(false)
const genericError = ref('')

onMounted(async () => {
  unlocked.value = (await readVault()) !== null
})

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function downloadText(text: string, filename: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function doUnlock(): Promise<void> {
  unlockError.value = ''
  try {
    await wallet.unlock(needsPassphrase.value ? unlockPass.value : undefined)
    unlocked.value = (await readVault()) !== null
    unlockPass.value = ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith('PASSPHRASE_REQUIRED')) {
      needsPassphrase.value = true
      return
    }
    unlockError.value = t('backup.error')
  }
}

async function downloadPassphraseBackup(): Promise<void> {
  passError.value = ''
  passDone.value = false
  if (pass.value.length < 8) {
    passError.value = t('backup.passphrase.tooShort')
    return
  }
  if (pass.value !== passConfirm.value) {
    passError.value = t('backup.passphrase.mismatch')
    return
  }
  busy.value = true
  genericError.value = ''
  try {
    const vault = await readVault()
    if (!vault) {
      unlocked.value = false
      return
    }
    const file = await exportPassphraseBackup(vault, pass.value)
    downloadText(file, `attestto-vault-backup-${stamp()}.json`)
    pass.value = ''
    passConfirm.value = ''
    passDone.value = true
  } catch {
    genericError.value = t('backup.error')
  } finally {
    busy.value = false
  }
}

</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-6">
    <header>
      <h1 class="text-3xl font-semibold tracking-tight text-[#f1f4f8]">{{ t('backup.title') }}</h1>
      <p class="mt-2 text-sm text-[#a8b4c4]">{{ t('backup.subtitle') }}</p>
    </header>

    <p
      v-if="genericError"
      class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
      role="alert"
    >
      {{ genericError }}
    </p>

    <!-- Locked gate — reading the full vault needs a session key. -->
    <section
      v-if="!unlocked"
      class="rounded-xl border border-[#243044] bg-[#111a28] p-5"
    >
      <p class="flex items-center gap-2 text-base font-semibold text-[#f1f4f8]">
        <LockClosedIcon class="size-5 text-[#a8b4c4]" />
        {{ t('backup.lockedTitle') }}
      </p>
      <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('backup.lockedBody') }}</p>

      <label v-if="needsPassphrase" class="mt-3 block">
        <span class="text-xs font-medium text-[#a8b4c4]">{{ t('backup.unlockPassphrase') }}</span>
        <input
          v-model="unlockPass"
          type="password"
          autocomplete="current-password"
          class="mt-1 w-full rounded-md border border-[#243044] bg-[#0d1520] px-3 py-2 text-sm text-[#f1f4f8] outline-none focus:border-[#4a8ec8]"
          @keyup.enter="doUnlock"
        />
      </label>

      <p v-if="unlockError" class="mt-2 text-sm text-red-300">{{ unlockError }}</p>

      <button
        type="button"
        class="mt-4 rounded-md bg-[#4a8ec8] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#3d7bb0]"
        @click="doUnlock"
      >
        {{ t('backup.unlock') }}
      </button>
    </section>

    <template v-else>
      <!-- 1. Password-protected file. -->
      <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5">
        <p class="flex items-center gap-2 text-base font-semibold text-[#f1f4f8]">
          <DocumentArrowDownIcon class="size-5 text-[#4a8ec8]" />
          {{ t('backup.passphrase.title') }}
        </p>
        <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('backup.passphrase.body') }}</p>

        <div class="mt-4 space-y-3">
          <label class="block">
            <span class="text-xs font-medium text-[#a8b4c4]">{{ t('backup.passphrase.newLabel') }}</span>
            <input
              v-model="pass"
              type="password"
              autocomplete="new-password"
              class="mt-1 w-full rounded-md border border-[#243044] bg-[#0d1520] px-3 py-2 text-sm text-[#f1f4f8] outline-none focus:border-[#4a8ec8]"
            />
          </label>
          <label class="block">
            <span class="text-xs font-medium text-[#a8b4c4]">{{ t('backup.passphrase.confirmLabel') }}</span>
            <input
              v-model="passConfirm"
              type="password"
              autocomplete="new-password"
              class="mt-1 w-full rounded-md border border-[#243044] bg-[#0d1520] px-3 py-2 text-sm text-[#f1f4f8] outline-none focus:border-[#4a8ec8]"
              @keyup.enter="downloadPassphraseBackup"
            />
          </label>
        </div>

        <p v-if="passError" class="mt-2 text-sm text-red-300">{{ passError }}</p>
        <p v-if="passDone" class="mt-2 text-sm text-emerald-300">{{ t('backup.passphrase.done') }}</p>

        <button
          type="button"
          :disabled="busy"
          class="mt-4 rounded-md bg-[#4a8ec8] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#3d7bb0] disabled:opacity-50"
          @click="downloadPassphraseBackup"
        >
          {{ t('backup.passphrase.action') }}
        </button>
      </section>
    </template>
  </div>
</template>
