<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useWalletStore } from '@/stores/wallet'
import { getPreferredIdentity, setPreferredIdentity } from '@/utils/site-identity-prefs'
import {
  ShieldCheckIcon,
  XMarkIcon,
  FingerPrintIcon,
  LockClosedIcon,
  KeyIcon,
  BanknotesIcon,
  DocumentCheckIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'

const wallet = useWalletStore()

const requestId = ref('')
const origin = ref('')
const loading = ref(true)
const approving = ref(false)
const error = ref<string | null>(null)

// Unlock flow state — set by the unlock-error catch below.
const passphrase = ref('')
const showPassphraseField = ref(false)
const showResetVault = ref(false)
const resetConfirm = ref(false)

/** Payment mode — detected from URL params */
const isPayment = ref(false)
const paymentAmount = ref(0)
const paymentCurrency = ref('USDC')
const merchantName = ref('')

/** Signing mode — detected from URL params */
const isSigning = ref(false)
const documentTitle = ref('')
const signerName = ref('')

/** Attestto self-attested PDF signing mode (ATT-364) */
const isAttesttoPdf = ref(false)
const attesttoPdfFileName = ref('')
const attesttoPdfHash = ref('')

/** Auth (login) mode — detected from URL params (ATT-123) */
const isAuth = ref(false)

/** Credential offer mode — identity sync or VC issuance push */
const isCredentialOffer = ref(false)
const credentialOfferId = ref('')
const credentialOfferFormat = ref('')
const credentialOfferIssuer = ref('')

/** Available DIDs the user can choose from */
interface AvailableDid {
  did: string
  label: string
  method: string
}

const availableDids = computed<AvailableDid[]>(() => {
  // Prefer platform-synced identities (did:sns, did:web, did:pkh, etc.) — these
  // are the ones the user knowingly created and expects to sign in with.
  // The local did:jwk fallback is intentionally NOT surfaced here; it's a
  // device-bound primitive, not a user-facing identity choice.
  return wallet.linkedIdentities.map((identity) => ({
    did: identity.did,
    label: identity.label,
    method: identity.did.split(':').slice(0, 2).join(':'),
  }))
})

const selectedDid = ref<string | null>(null)

const formattedAmount = computed(() => {
  return `${paymentAmount.value.toFixed(2)} ${paymentCurrency.value}`
})

onMounted(async () => {
  const params = new URLSearchParams(window.location.search)

  // Detect mode: credential-offer, auth (login), attestto PDF, signing, payment, or CHAPI
  const credentialOfferParam = params.get('credentialOfferId')
  const authReqId = params.get('authRequest')
  const signReqId = params.get('signingRequest')
  const payReqId = params.get('paymentRequest')
  const chapiReqId = params.get('chapiRequest')
  const attesttoPdfReqId = params.get('attesttoPdfRequest')

  if (credentialOfferParam) {
    isCredentialOffer.value = true
    credentialOfferId.value = credentialOfferParam
    requestId.value = credentialOfferParam
    credentialOfferFormat.value = params.get('format') || ''
    credentialOfferIssuer.value = params.get('issuerName') || 'A site'
    origin.value = params.get('origin') || ''
  } else if (authReqId) {
    isAuth.value = true
    requestId.value = authReqId
    origin.value = params.get('origin') || ''
  } else if (attesttoPdfReqId) {
    isAttesttoPdf.value = true
    requestId.value = attesttoPdfReqId
    origin.value = params.get('origin') || ''
    attesttoPdfFileName.value = params.get('fileName') || 'document.pdf'
    attesttoPdfHash.value = params.get('documentHash') || ''
  } else if (signReqId) {
    isSigning.value = true
    requestId.value = signReqId
    origin.value = params.get('origin') || ''
    documentTitle.value = params.get('documentTitle') || ''
    signerName.value = params.get('signerName') || ''
  } else if (payReqId) {
    isPayment.value = true
    requestId.value = payReqId
    origin.value = params.get('origin') || ''
    paymentAmount.value = Number(params.get('amount') || '0')
    paymentCurrency.value = params.get('currency') || 'USDC'
    merchantName.value = params.get('merchant') || ''
  } else if (chapiReqId) {
    requestId.value = chapiReqId
    origin.value = params.get('origin') || ''
  }

  if (!requestId.value) {
    error.value = 'No request ID'
    loading.value = false
    return
  }

  // Load public data (always works — no passkey)
  await wallet.loadPublicData()

  // Default-select: prefer the identity the user chose last time for this origin
  // (if it still exists), otherwise the first available platform-synced identity.
  // availableDids is sourced from wallet.linkedIdentities only — local did:jwk
  // is intentionally excluded.
  if (availableDids.value.length > 0) {
    const remembered = await getPreferredIdentity(origin.value)
    const stillAvailable = remembered && availableDids.value.some((d) => d.did === remembered)
    selectedDid.value = stillAvailable ? remembered : availableDids.value[0].did
  }

  loading.value = false
})

async function approve() {
  approving.value = true
  error.value = null

  try {
    // Credential-offer mode: no vault unlock needed — just accept the offer
    // (the background handler also records origin as trusted for identity offers).
    if (isCredentialOffer.value) {
      const resp = await chrome.runtime.sendMessage({
        type: 'CREDENTIAL_OFFER_APPROVE',
        payload: { notifId: credentialOfferId.value },
      })
      if (resp?.ok) {
        window.close()
      } else {
        error.value = resp?.error || 'Failed to accept credential offer'
      }
      return
    }

    // Unlock the vault at the moment of signing. Vaults set up with a
    // passphrase need it passed here; ones using PRF unlock silently.
    if (!wallet.isUnlocked) {
      try {
        await wallet.unlock(showPassphraseField.value ? passphrase.value : undefined)
      } catch (unlockErr) {
        const msg = unlockErr instanceof Error ? unlockErr.message : 'Unlock failed'

        // Vault set up with passphrase KDF — reveal field and let the user retry
        if (msg.startsWith('PASSPHRASE_REQUIRED')) {
          showPassphraseField.value = true
          error.value = 'Enter your recovery passphrase to sign in.'
          return
        }

        // PRF-only vault on an authenticator that no longer returns a PRF
        // secret — unrecoverable. Reset is the only path forward.
        if (msg.startsWith('PRF_UNAVAILABLE')) {
          showResetVault.value = true
          error.value = 'Your vault cannot be unlocked on this device. Reset and set it up again to continue.'
          return
        }

        throw unlockErr
      }
    }

    const msgType = isAuth.value
      ? 'AUTH_APPROVE'
      : isAttesttoPdf.value
        ? 'SIGN_ATTESTTO_PDF_APPROVE'
        : isSigning.value
          ? 'SIGN_DOCUMENT_APPROVE'
          : isPayment.value ? 'PAYMENT_APPROVE' : 'CHAPI_APPROVE'
    const payload: Record<string, string> = { requestId: requestId.value }

    if ((isAuth.value || isPayment.value || isSigning.value || isAttesttoPdf.value) && selectedDid.value) {
      payload.selectedDid = selectedDid.value
    }

    const response = await chrome.runtime.sendMessage({
      type: msgType,
      payload,
    })

    if (response?.ok) {
      // Persist the user's identity choice for this origin so the next prompt
      // defaults to the same selection.
      if (selectedDid.value && origin.value) {
        await setPreferredIdentity(origin.value, selectedDid.value)
      }
      window.close()
    } else {
      error.value = response?.error || 'Approval failed'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error'
  } finally {
    approving.value = false
  }
}

async function deny() {
  if (isCredentialOffer.value) {
    await chrome.runtime.sendMessage({
      type: 'CREDENTIAL_OFFER_DENY',
      payload: { notifId: credentialOfferId.value },
    })
    window.close()
    return
  }
  const msgType = isAuth.value
    ? 'AUTH_DENY'
    : isAttesttoPdf.value
      ? 'SIGN_ATTESTTO_PDF_DENY'
      : isSigning.value
        ? 'SIGN_DOCUMENT_DENY'
        : isPayment.value ? 'PAYMENT_DENY' : 'CHAPI_DENY'
  await chrome.runtime.sendMessage({
    type: msgType,
    payload: { requestId: requestId.value },
  })
  window.close()
}

async function createDidAndRetry() {
  await wallet.createDid()
  if (wallet.did) {
    selectedDid.value = wallet.did
  }
}

async function handleResetVault() {
  if (!resetConfirm.value) {
    resetConfirm.value = true
    return
  }
  approving.value = true
  try {
    await wallet.resetWallet()
    // Vault is gone. The signing flow can't continue — tell the page to abandon
    // this request so it can prompt the user to start over from scratch.
    await chrome.runtime.sendMessage({
      type: isAuth.value
        ? 'AUTH_DENY'
        : isAttesttoPdf.value
          ? 'SIGN_ATTESTTO_PDF_DENY'
          : isSigning.value
            ? 'SIGN_DOCUMENT_DENY'
            : isPayment.value ? 'PAYMENT_DENY' : 'CHAPI_DENY',
      payload: { requestId: requestId.value },
    })
    window.close()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Reset failed'
  } finally {
    approving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-sm p-4 space-y-4">
    <!-- ═══════════════════════════════════════════════════════════════
         CREDENTIAL OFFER MODE — short-circuits the DID-picker UX
         (used when a site pushes an identity or VC to be stored)
         ═══════════════════════════════════════════════════════════════ -->
    <template v-if="isCredentialOffer">
      <div class="rounded-lg border border-indigo-700/50 bg-indigo-950/30 p-4 text-center">
        <ShieldCheckIcon class="mx-auto h-8 w-8 text-indigo-400" />
        <p class="mt-2 text-sm font-semibold text-white">
          {{ credentialOfferFormat === 'attestto-id' ? 'Add Identity?' : 'Add Credential?' }}
        </p>
        <p class="mt-1 text-[11px] text-slate-400">
          {{ credentialOfferFormat === 'attestto-id'
            ? 'A site wants to sync an identity to your wallet'
            : 'A site wants to add a verifiable credential to your wallet' }}
        </p>
      </div>

      <div class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2">
        <div>
          <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Requesting site</p>
          <p class="mt-1 text-xs font-mono text-white break-all">{{ origin || 'Unknown' }}</p>
        </div>
        <div>
          <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Issuer</p>
          <p class="mt-1 text-xs text-white">{{ credentialOfferIssuer || 'Unknown' }}</p>
        </div>
        <div>
          <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Format</p>
          <p class="mt-1 text-xs font-mono text-slate-300">{{ credentialOfferFormat }}</p>
        </div>
      </div>

      <p v-if="credentialOfferFormat === 'attestto-id'" class="text-[10px] text-slate-500 text-center leading-relaxed">
        Approving will trust <strong class="text-slate-300">{{ origin }}</strong> for future identity syncs (silent, no further prompts).
        You can revoke this at any time from Settings → Trusted Sites.
      </p>
      <p v-else class="text-[10px] text-slate-500 text-center leading-relaxed">
        The credential will be stored locally in your wallet. No private keys leave this device.
      </p>

      <div v-if="error" class="rounded-lg border border-red-700/50 bg-red-950/30 p-3">
        <p class="text-xs text-red-300">{{ error }}</p>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <button
          class="rounded-lg border border-slate-700 px-3 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-1.5"
          @click="deny"
        >
          <XMarkIcon class="h-4 w-4" />
          Deny
        </button>
        <button
          class="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
          :disabled="approving"
          @click="approve"
        >
          <ShieldCheckIcon class="h-4 w-4" />
          {{ approving ? 'Adding...' : 'Approve' }}
        </button>
      </div>
    </template>

    <!-- ═══════════════════════════════════════════════════════════════
         ALL OTHER MODES (auth, signing, payment, CHAPI, etc.)
         ═══════════════════════════════════════════════════════════════ -->
    <template v-else>
    <!-- Header — Auth (Login) Mode (ATT-123) -->
    <div v-if="isAuth" class="rounded-lg border border-purple-700/50 bg-purple-950/30 p-4 text-center">
      <LockClosedIcon class="mx-auto h-8 w-8 text-purple-400" />
      <p class="mt-2 text-sm font-semibold text-white">Sign In</p>
      <p class="mt-1 text-[11px] text-slate-400">
        Confirm your identity to sign in
      </p>
    </div>

    <!-- Header — Attestto self-attested PDF Sign Mode (ATT-364) -->
    <div v-else-if="isAttesttoPdf" class="rounded-lg border border-blue-700/50 bg-blue-950/30 p-4 text-center">
      <DocumentCheckIcon class="mx-auto h-8 w-8 text-blue-400" />
      <p class="mt-2 text-sm font-semibold text-white">Sign PDF</p>
      <p class="mt-1 text-[11px] text-slate-400">
        Attestto self-attested signature (Ed25519)
      </p>
    </div>

    <!-- Header — Signing Mode -->
    <div v-else-if="isSigning" class="rounded-lg border border-blue-700/50 bg-blue-950/30 p-4 text-center">
      <DocumentCheckIcon class="mx-auto h-8 w-8 text-blue-400" />
      <p class="mt-2 text-sm font-semibold text-white">Sign Document</p>
      <p class="mt-1 text-[11px] text-slate-400">
        Sign this document with your Attestto ID
      </p>
    </div>

    <!-- Header — Payment Mode -->
    <div v-else-if="isPayment" class="rounded-lg border border-emerald-700/50 bg-emerald-950/30 p-4 text-center">
      <BanknotesIcon class="mx-auto h-8 w-8 text-emerald-400" />
      <p class="mt-2 text-sm font-semibold text-white">Payment Request</p>
      <p class="mt-1 text-[11px] text-slate-400">
        Approve this payment with your identity
      </p>
    </div>

    <!-- Header — Identity Mode -->
    <div v-else class="rounded-lg border border-indigo-700/50 bg-indigo-950/30 p-4 text-center">
      <ShieldCheckIcon class="mx-auto h-8 w-8 text-indigo-400" />
      <p class="mt-2 text-sm font-semibold text-white">Identity Request</p>
      <p class="mt-1 text-[11px] text-slate-400">
        A site wants to verify your identity
      </p>
    </div>

    <!-- Attestto self-attested PDF Sign Details (ATT-364) -->
    <div v-if="isAttesttoPdf" class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Document</p>
        <p class="text-xs font-medium text-white">{{ attesttoPdfFileName }}</p>
      </div>
      <div v-if="attesttoPdfHash" class="flex items-center justify-between">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">SHA-256</p>
        <p class="text-xs font-mono text-white" style="font-size: 10px; word-break: break-all;">{{ attesttoPdfHash }}</p>
      </div>
    </div>

    <!-- Signing Details -->
    <div v-if="isSigning" class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Document</p>
        <p class="text-xs font-medium text-white">{{ documentTitle || 'Untitled' }}</p>
      </div>
      <div v-if="signerName" class="flex items-center justify-between">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Signing as</p>
        <p class="text-xs text-white">{{ signerName }}</p>
      </div>
    </div>

    <!-- Payment Details -->
    <div v-if="isPayment" class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Amount</p>
        <p class="text-base font-semibold text-white">{{ formattedAmount }}</p>
      </div>
      <div v-if="merchantName" class="flex items-center justify-between">
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">To</p>
        <p class="text-xs text-white">{{ merchantName }}</p>
      </div>
    </div>

    <!-- Origin -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">Requesting site</p>
      <p class="mt-1 text-xs font-mono text-white break-all">{{ origin || 'Unknown' }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="rounded-lg border border-slate-700 bg-slate-900 p-6 text-center">
      <p class="text-xs text-slate-400">Loading wallet...</p>
    </div>

    <!-- No DID created yet -->
    <template v-else-if="!wallet.did">
      <div class="rounded-lg border border-amber-700/50 bg-amber-950/30 p-4 text-center space-y-3">
        <KeyIcon class="mx-auto h-6 w-6 text-amber-400" />
        <p class="text-xs text-amber-200">No DID created yet</p>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <button
          class="rounded-lg bg-indigo-600 px-3 py-2.5 text-xs font-medium text-white hover:bg-indigo-500"
          @click="createDidAndRetry()"
        >
          Create DID
        </button>
        <button
          class="rounded-lg border border-slate-700 px-3 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
          @click="deny"
        >
          Cancel
        </button>
      </div>
    </template>

    <!-- Ready to approve -->
    <template v-else>
      <!-- DID Picker -->
      <div
        class="rounded-lg border p-3 space-y-2"
        :class="isPayment ? 'border-emerald-700/50 bg-emerald-950/20' : 'border-emerald-700/50 bg-emerald-950/20'"
      >
        <p class="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {{ isAuth ? 'Sign in with this identity' : (isSigning || isAttesttoPdf) ? 'Sign with this identity' : isPayment ? 'Pay from this identity' : 'Share this identity' }}
        </p>
        <div
          v-for="d in availableDids"
          :key="d.did"
          class="flex items-center gap-2 rounded-md p-2"
          :class="selectedDid === d.did
            ? 'border border-emerald-600 bg-emerald-950/30'
            : 'border border-slate-700 hover:bg-slate-800 cursor-pointer'"
          @click="selectedDid = d.did"
        >
          <FingerPrintIcon class="h-4 w-4 text-emerald-400 shrink-0" />
          <div class="flex-1 min-w-0">
            <p class="text-[11px] font-medium text-white">{{ d.label }}</p>
            <p class="text-[10px] font-mono text-slate-400 truncate">{{ d.did }}</p>
          </div>
          <span class="text-[9px] px-1.5 py-0.5 rounded-full border border-slate-600 text-slate-400">{{ d.method }}</span>
        </div>
      </div>

      <!-- Context text -->
      <p v-if="isAuth" class="text-[10px] text-slate-500 text-center leading-relaxed">
        You're signing in to <strong class="text-slate-300">{{ origin }}</strong> with your Attestto ID.
        A stateless proof-of-possession will be signed — no credentials are shared.
      </p>
      <p v-else-if="isAttesttoPdf" class="text-[10px] text-slate-500 text-center leading-relaxed">
        Your Attestto self-attested signature (Ed25519) will be embedded into <strong class="text-slate-300">{{ attesttoPdfFileName }}</strong>.
        The signed PDF will be verifiable on <strong class="text-slate-300">verify.attestto.com</strong>.
      </p>
      <p v-else-if="isSigning" class="text-[10px] text-slate-500 text-center leading-relaxed">
        Your digital signature will be applied to <strong class="text-slate-300">{{ documentTitle || 'this document' }}</strong>.
        This is a legally binding action.
      </p>
      <p v-else-if="isPayment" class="text-[10px] text-slate-500 text-center leading-relaxed">
        Your payment of <strong class="text-emerald-300">{{ formattedAmount }}</strong> will be signed with your selected identity and sent to <strong class="text-slate-300">{{ origin }}</strong>.
      </p>
      <p v-else class="text-[10px] text-slate-500 text-center leading-relaxed">
        Your DID will be shared with <strong class="text-slate-300">{{ origin }}</strong> for identity attribution.
        No private keys are disclosed.
      </p>

      <!-- Passphrase field — revealed when unlock returned PASSPHRASE_REQUIRED -->
      <div v-if="showPassphraseField" class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2">
        <label class="block text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Recovery passphrase
        </label>
        <input
          v-model="passphrase"
          type="password"
          autocomplete="current-password"
          placeholder="Enter your passphrase"
          class="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
          @keyup.enter="approve"
        />
      </div>

      <!-- Error -->
      <div v-if="error" class="rounded-lg border border-red-700/50 bg-red-950/30 p-3">
        <p class="text-xs text-red-300">{{ error }}</p>
      </div>

      <!-- Reset vault panel — only when unlock returned PRF_UNAVAILABLE -->
      <div v-if="showResetVault" class="rounded-lg border border-red-700/50 bg-red-950/30 p-3 space-y-2">
        <p class="text-[11px] font-semibold text-red-300">Reset required</p>
        <p class="text-[10px] text-slate-400 leading-relaxed">
          Wiping the vault will delete <strong>all credentials, DIDs, and identities</strong> stored locally.
          You'll need to set up the vault again and re-sync your identities from the platform.
        </p>
        <button
          class="w-full rounded-md px-3 py-2 text-xs font-medium text-white flex items-center justify-center gap-1.5"
          :class="resetConfirm ? 'bg-red-600 hover:bg-red-500' : 'bg-red-900/60 hover:bg-red-800/60 border border-red-700/50'"
          :disabled="approving"
          @click="handleResetVault"
        >
          <TrashIcon class="h-3.5 w-3.5" />
          {{ resetConfirm ? 'Confirm — wipe everything' : 'Reset vault' }}
        </button>
      </div>

      <!-- Action buttons — hidden when the reset panel is shown (no recovery path) -->
      <div v-if="!showResetVault" class="grid grid-cols-2 gap-2">
        <button
          class="rounded-lg border border-slate-700 px-3 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 flex items-center justify-center gap-1.5"
          @click="deny"
        >
          <XMarkIcon class="h-4 w-4" />
          Deny
        </button>
        <button
          class="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-medium text-white disabled:opacity-50"
          :class="isAuth ? 'bg-purple-600 hover:bg-purple-500' : (isSigning || isAttesttoPdf) ? 'bg-blue-600 hover:bg-blue-500' : isPayment ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-indigo-600 hover:bg-indigo-500'"
          :disabled="approving || !selectedDid"
          @click="approve"
        >
          <component :is="isAuth ? LockClosedIcon : (isSigning || isAttesttoPdf) ? DocumentCheckIcon : isPayment ? BanknotesIcon : ShieldCheckIcon" class="h-4 w-4" />
          {{ approving ? 'Signing...' : (isAuth ? 'Sign In' : (isSigning || isAttesttoPdf) ? 'Sign' : isPayment ? 'Pay' : 'Approve') }}
        </button>
      </div>
    </template>
    </template>
  </div>
</template>
