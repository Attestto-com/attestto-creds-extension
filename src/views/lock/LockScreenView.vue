<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { FingerPrintIcon, TrashIcon, ArrowPathIcon } from '@heroicons/vue/24/outline'
import { useWalletStore, type VaultData } from '@/stores/wallet'
import ExtensionHeader from '@/components/layout/ExtensionHeader.vue'
import RestoreBackupPanel from '@/components/backup/RestoreBackupPanel.vue'

const wallet = useWalletStore()
const loading = ref(true)
const acting = ref(false)
const error = ref<string | null>(null)
// info: amber-tinted notice for "needs your attention but nothing broke"
// states (e.g. PRF unsupported → set a passphrase to continue). Kept separate
// from `error` so the red-error styling stays for genuine failures.
const info = ref<string | null>(null)

const showReset = ref(false)
const resetConfirm = ref(false)

// Restore-from-backup: the panel decrypts a backup into `pendingRestore`, we
// reset local protection, and the normal setup flow re-protects the device;
// once setup succeeds we write the restored vault (see handleAction).
const showRestore = ref(false)
const pendingRestore = ref<VaultData | null>(null)

onMounted(async () => {
  await wallet.checkSetup()
  loading.value = false
})

async function handleAction(): Promise<void> {
  acting.value = true
  error.value = null
  info.value = null

  try {
    if (wallet.isSetUp) {
      await wallet.unlock()
    } else {
      // Setup is one passkey and nothing else. A restored backup is re-protected
      // under the new device's PRF key, so it needs no secret from the user
      // either — the backup file's own passphrase was already spent decrypting it.
      await wallet.setup()
      if (pendingRestore.value) {
        await wallet.restoreFromBackup(pendingRestore.value)
        pendingRestore.value = null
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Authentication failed'

    // The existing vault's key cannot be reproduced here. Reset is the path —
    // there is no passphrase to fall back to and nothing irreplaceable inside.
    if (msg.startsWith('PRF_UNAVAILABLE')) {
      showReset.value = true
      error.value = 'This wallet cannot be unlocked on this device. Reset it and set it up again.'
      return
    }

    // This device cannot hold a vault at all. Say so; do not offer a password.
    if (msg.startsWith('PRF_UNSUPPORTED')) {
      error.value = 'This device cannot secure a wallet — its passkey does not support the encryption this needs. Try Chrome or Safari on a device with Touch ID, Windows Hello, or a security key.'
      return
    }

    error.value = msg
  } finally {
    acting.value = false
  }
}

/**
 * A backup was decrypted. Wipe the (unreachable) local vault and drop into
 * setup mode so the user sets a new device password; handleAction then writes
 * the restored vault once setup succeeds.
 */
async function onDecrypted(vault: VaultData): Promise<void> {
  acting.value = true
  error.value = null
  try {
    pendingRestore.value = vault
    showRestore.value = false
    await wallet.resetWallet()
    await wallet.checkSetup()
    info.value = 'Backup loaded. Set up your passkey to finish restoring on this device.'
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Restore failed'
    pendingRestore.value = null
  } finally {
    acting.value = false
  }
}

async function handleReset(): Promise<void> {
  if (!resetConfirm.value) {
    resetConfirm.value = true
    return
  }
  acting.value = true
  try {
    await wallet.resetWallet()
    showReset.value = false
    resetConfirm.value = false
    error.value = null
    info.value = null
    // checkSetup re-evaluates isSetUp (now false) so the view flips to setup mode
    await wallet.checkSetup()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Reset failed'
  } finally {
    acting.value = false
  }
}
</script>

<template>
  <!-- Shared extension chrome (header + content) so the lock/setup view feels
       like the same surface as IdentityListView post-unlock. `minimal` hides
       settings/lock/unlock buttons that would have no meaningful target here. -->
  <div class="flex min-h-[400px] flex-col">
    <ExtensionHeader :is-unlocked="false" minimal />
    <div class="flex flex-1 flex-col items-center justify-center px-6 py-6">
<!-- Loading -->
    <div v-if="loading" class="text-xs text-slate-500">Loading...</div>

    <!-- Action UI -->
    <template v-else>
      <!-- Action button — the whole of setup, and the whole of unlock. -->
      <button
        class="w-full max-w-[260px] rounded-xl bg-indigo-600 px-6 py-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        :disabled="acting"
        @click="handleAction"
      >
        <FingerPrintIcon class="h-4 w-4" />
        <template v-if="acting">
          {{ wallet.isSetUp ? 'Unlocking...' : 'Setting up vault...' }}
        </template>
        <template v-else>
          {{ wallet.isSetUp ? 'Unlock with Passkey' : 'Set Up Vault' }}
        </template>
      </button>

      <!-- Info notice — amber, for "next step needed" states (e.g. PRF unsupported) -->
      <div
        v-if="info"
        class="mt-3 w-full max-w-[260px] rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2"
      >
        <p class="text-[11px] text-amber-200 leading-relaxed">{{ info }}</p>
      </div>

      <!-- Error — red, for genuine failures -->
      <p v-if="error" class="mt-3 text-[11px] text-red-400 text-center max-w-[280px] leading-relaxed">
        {{ error }}
      </p>

      <!-- Restore from a backup — decrypt panel, then the setup flow re-protects
           the device and writes the restored vault. -->
      <div v-if="showRestore" class="mt-4">
        <RestoreBackupPanel @decrypted="onDecrypted" @cancel="showRestore = false" />
      </div>
      <button
        v-else-if="!showReset && !pendingRestore"
        type="button"
        class="mt-4 flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-indigo-400"
        @click="showRestore = true"
      >
        <ArrowPathIcon class="h-3 w-3" />
        Restore from a backup
      </button>

      <!-- Reset vault — only shown when unlock has failed unrecoverably -->
      <div v-if="showReset" class="mt-4 w-full max-w-[260px] rounded-lg border border-red-700/50 bg-red-950/30 p-3 space-y-2">
        <p class="text-[11px] font-semibold text-red-300">Reset required</p>
        <p class="text-[10px] text-slate-400 leading-relaxed">
          Wiping the vault will delete <strong>all credentials, DIDs, and identities</strong> stored locally.
          You'll be sent back through onboarding. This cannot be undone.
        </p>
        <button
          class="w-full rounded-md px-3 py-2 text-xs font-medium text-white flex items-center justify-center gap-1.5"
          :class="resetConfirm ? 'bg-red-600 hover:bg-red-500' : 'bg-red-900/60 hover:bg-red-800/60 border border-red-700/50'"
          @click="handleReset"
        >
          <TrashIcon class="h-3.5 w-3.5" />
          {{ resetConfirm ? 'Confirm — wipe everything' : 'Reset vault' }}
        </button>
      </div>
    </template>

    <!-- Version -->
    <p class="mt-6 text-[9px] text-slate-700">v0.1.0</p>
    </div>
  </div>
</template>
