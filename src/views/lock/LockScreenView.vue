<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { FingerPrintIcon, KeyIcon, TrashIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/vue/24/outline'
import { useWalletStore } from '@/stores/wallet'
import { APP_NAME } from '@/config/app'

const wallet = useWalletStore()
const loading = ref(true)
const acting = ref(false)
const error = ref<string | null>(null)
// info: amber-tinted notice for "needs your attention but nothing broke"
// states (e.g. PRF unsupported → set a passphrase to continue). Kept separate
// from `error` so the red-error styling stays for genuine failures.
const info = ref<string | null>(null)

const passphrase = ref('')
const passphraseConfirm = ref('')
// Setup mode: passphrase fields hidden by default; user opens via the optional
// disclosure OR they auto-open when PRF is unavailable on this authenticator.
const showPassphraseSetup = ref(false)
// Unlock mode: only revealed when the vault was set up with a passphrase and
// the passkey unlock path returned PASSPHRASE_REQUIRED.
const showPassphrase = ref(false)
const showReset = ref(false)
const resetConfirm = ref(false)

const setupValidation = computed<string | null>(() => {
  if (wallet.isSetUp) return null
  if (!passphrase.value) return null // optional during setup; required only if PRF unsupported
  if (passphrase.value.length < 8) return 'Passphrase must be at least 8 characters'
  if (passphrase.value !== passphraseConfirm.value) return 'Passphrases do not match'
  return null
})

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
      await wallet.unlock(showPassphrase.value ? passphrase.value : undefined)
    } else {
      if (setupValidation.value) {
        error.value = setupValidation.value
        return
      }
      await wallet.setup(passphrase.value || undefined)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Authentication failed'

    // Vault was set up with passphrase but unlock didn't supply one — prompt for it
    if (msg.startsWith('PASSPHRASE_REQUIRED')) {
      showPassphrase.value = true
      info.value = 'Enter your passphrase to unlock.'
      return
    }

    // Vault was set up with PRF but authenticator no longer returns PRF — unrecoverable
    if (msg.startsWith('PRF_UNAVAILABLE')) {
      showReset.value = true
      error.value = 'This vault cannot be unlocked on this device (PRF unavailable). You must reset.'
      return
    }

    // Setup requires passphrase because PRF unsupported on this authenticator —
    // reveal the (previously hidden) passphrase fields and prompt the user.
    // Treated as an informational step, not an error, so the UI doesn't read
    // as "something broke" when the next step is just "type a passphrase".
    if (msg.startsWith('PRF_REQUIRES_PASSPHRASE')) {
      showPassphraseSetup.value = true
      info.value = 'Your passkey was created, but this device can’t use it as a vault key. Set a recovery passphrase to finish setup.'
      return
    }

    error.value = msg
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
    showPassphrase.value = false
    showPassphraseSetup.value = false
    resetConfirm.value = false
    passphrase.value = ''
    passphraseConfirm.value = ''
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
  <div class="flex min-h-[400px] flex-col items-center justify-center px-6">
    <!-- Logo area -->
    <div class="mb-6 text-center">
      <div class="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600/20">
        <FingerPrintIcon class="h-8 w-8 text-indigo-400" />
      </div>
      <h1 class="text-lg font-bold text-white">{{ APP_NAME }}</h1>
      <p class="mt-1 text-[11px] text-slate-500">Your self-sovereign identity</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-xs text-slate-500">Loading...</div>

    <!-- Action UI -->
    <template v-else>
      <!-- Passphrase input — shown on UNLOCK when PASSPHRASE_REQUIRED, or on SETUP
           after the user opens the optional disclosure or PRF_REQUIRES_PASSPHRASE fires. -->
      <div
        v-if="(wallet.isSetUp && showPassphrase) || (!wallet.isSetUp && showPassphraseSetup)"
        class="w-full max-w-[260px] space-y-2 mb-3"
      >
        <label class="block text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {{ wallet.isSetUp ? 'Passphrase' : 'Recovery passphrase' }}
        </label>
        <input
          v-model="passphrase"
          type="password"
          autocomplete="current-password"
          placeholder="Min 8 characters"
          class="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
        />
        <input
          v-if="!wallet.isSetUp"
          v-model="passphraseConfirm"
          type="password"
          autocomplete="new-password"
          placeholder="Confirm passphrase"
          class="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
        />
        <p v-if="!wallet.isSetUp" class="text-[10px] text-slate-500 leading-relaxed">
          A recovery passphrase lets you re-open your vault if your passkey is lost or
          your authenticator doesn't support hardware-backed key derivation (PRF). Write it down.
        </p>
      </div>

      <!-- Action button -->
      <button
        class="w-full max-w-[260px] rounded-xl bg-indigo-600 px-6 py-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        :disabled="acting || (!wallet.isSetUp && !!setupValidation)"
        @click="handleAction"
      >
        <KeyIcon v-if="wallet.isSetUp && showPassphrase" class="h-4 w-4" />
        <FingerPrintIcon v-else class="h-4 w-4" />
        <template v-if="acting">
          {{ wallet.isSetUp ? 'Unlocking...' : 'Setting up vault...' }}
        </template>
        <template v-else>
          {{ wallet.isSetUp
            ? (showPassphrase ? 'Unlock with Passphrase' : 'Unlock with Passkey')
            : 'Set Up Vault' }}
        </template>
      </button>

      <!-- Optional disclosure — only in SETUP mode, only when passphrase fields not yet shown -->
      <button
        v-if="!wallet.isSetUp && !showPassphraseSetup"
        type="button"
        class="mt-3 text-[11px] text-slate-400 hover:text-indigo-400 transition-colors flex items-center gap-1"
        @click="showPassphraseSetup = true"
      >
        <ChevronDownIcon class="h-3 w-3" />
        Add a recovery passphrase (optional)
      </button>

      <!-- Collapse — only in SETUP mode, only when user opened the disclosure proactively
           (not when PRF_REQUIRES_PASSPHRASE forced it — `info` is set in that case
           and the passphrase is then required, so hiding would just confuse). -->
      <button
        v-if="!wallet.isSetUp && showPassphraseSetup && !info"
        type="button"
        class="mt-3 text-[11px] text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
        @click="() => { showPassphraseSetup = false; passphrase = ''; passphraseConfirm = '' }"
      >
        <ChevronUpIcon class="h-3 w-3" />
        Hide recovery passphrase
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
</template>
