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
import { LockClosedIcon, DocumentArrowDownIcon, KeyIcon } from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import { readVault } from '@/utils/vault'
import { exportPassphraseBackup, exportShamirBackup } from '@/services/vault-backup'

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

/**
 * Split-recovery state.
 *
 * `exportShamirBackup` and the restore half (`importShamirBackup`, reached from
 * `RestoreBackupPanel` on the lock screen) both shipped and are round-tripped in
 * `vault-backup.spec.ts`. Nothing ever called the export, so the lock screen
 * asked the user for a file and two keys that no part of the product could
 * produce — a restore form that could not be satisfied. This section is the
 * missing producer.
 */
const shares = ref<string[]>([])
const copiedIndex = ref<number | null>(null)

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

/**
 * Generate the split recovery set: one encrypted file plus three keys, any two
 * of which reconstruct it.
 *
 * The shares are the 2-of-3 split of the file's content key, NOT of the private
 * key — so a share is worthless without the file, and the file is worthless
 * without two shares. That is the property the warning copy promises, and it is
 * why this is safe to hand to a person who is not the user.
 *
 * They are held in memory only. There is nowhere safe to persist them: writing
 * them into the vault would put two of the three next to the thing they unlock,
 * and this view has no business choosing where a user's guardian key lives.
 */
async function generateShamirBackup(): Promise<void> {
  busy.value = true
  genericError.value = ''
  shares.value = []
  try {
    const vault = await readVault()
    if (!vault) {
      unlocked.value = false
      return
    }
    const result = await exportShamirBackup(vault)
    downloadText(result.file, `attestto-vault-recovery-${stamp()}.json`)
    shares.value = [...result.shares]
  } catch {
    genericError.value = t('backup.error')
  } finally {
    busy.value = false
  }
}

async function copyShare(index: number): Promise<void> {
  await navigator.clipboard.writeText(shares.value[index])
  copiedIndex.value = index
}

/** The keys as a plain file, for a user who would rather not copy three strings by hand. */
function downloadShares(): void {
  const body = shares.value.map((share, i) => `Key ${i + 1}:\n${share}\n`).join('\n')
  downloadText(body, `attestto-recovery-keys-${stamp()}.txt`, 'text/plain')
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

      <!-- 2. Split recovery — one file plus three 2-of-3 keys. -->
      <section class="rounded-xl border border-[#243044] bg-[#111a28] p-5">
        <p class="flex items-center gap-2 text-base font-semibold text-[#f1f4f8]">
          <KeyIcon class="size-5 text-[#4a8ec8]" />
          {{ t('backup.shamir.title') }}
        </p>
        <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('backup.shamir.body') }}</p>

        <button
          type="button"
          :disabled="busy"
          class="mt-4 rounded-md bg-[#4a8ec8] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#3d7bb0] disabled:opacity-50"
          @click="generateShamirBackup"
        >
          {{ t('backup.shamir.action') }}
        </button>

        <div v-if="shares.length" class="mt-4 space-y-3">
          <p class="text-sm text-emerald-300">{{ t('backup.shamir.fileNote') }}</p>

          <!-- The warning sits ABOVE the keys: a user who stores all three in one
               place has a single-factor backup wearing a three-factor label. -->
          <p
            class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
            role="alert"
          >
            {{ t('backup.shamir.warn') }}
          </p>

          <p class="text-xs font-medium text-[#a8b4c4]">{{ t('backup.shamir.sharesTitle') }}</p>
          <div v-for="(share, i) in shares" :key="i" class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-medium text-[#a8b4c4]">
                {{ t('backup.shamir.shareLabel', { n: i + 1 }) }}
              </span>
              <button
                type="button"
                class="rounded-md border border-[#243044] px-2 py-1 text-xs text-[#a8b4c4] transition-colors hover:text-[#f1f4f8]"
                @click="copyShare(i)"
              >
                {{ copiedIndex === i ? t('backup.shamir.copied') : t('backup.shamir.copy') }}
              </button>
            </div>
            <code
              class="block break-all rounded-md border border-[#243044] bg-[#0d1520] px-3 py-2 text-xs text-[#f1f4f8]"
            >{{ share }}</code>
          </div>

          <button
            type="button"
            class="rounded-md border border-[#243044] px-3 py-2 text-xs font-medium text-[#a8b4c4] transition-colors hover:text-[#f1f4f8]"
            @click="downloadShares"
          >
            {{ t('backup.shamir.downloadShares') }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
