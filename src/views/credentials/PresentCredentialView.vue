<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeftIcon,
  ClipboardIcon,
  CheckIcon,
  EyeIcon,
} from '@heroicons/vue/24/outline'
import { useCredentialsStore } from '@/stores/credentials'
import { useWalletStore } from '@/stores/wallet'
import { parseSdJwt, decodeDisclosures, createSdJwtPresentation } from '@/services/sdjwt'
import { createJsonLdVp } from '@/services/jsonld-vp'
import type { StoredCredential } from '@/types/credential'

const route = useRoute()
const router = useRouter()
const credentialsStore = useCredentialsStore()
const walletStore = useWalletStore()

const credential = ref<StoredCredential | null>(null)
const disclosureItems = ref<Array<{ salt: string; claimName: string; claimValue: unknown; selected: boolean }>>([])
const nonce = ref('')
const audience = ref('')
const generatedVp = ref('')
const copied = ref(false)
const generating = ref(false)
const error = ref('')
const showPreview = ref(false)

const isReady = computed(() => {
  if (!credential.value) return false
  if (!nonce.value.trim()) return false
  if (credential.value.format === 'sd-jwt') {
    return disclosureItems.value.some((d) => d.selected)
  }
  return true
})

const selectedClaims = computed(() => {
  if (!credential.value) return {}
  if (credential.value.format === 'sd-jwt') {
    const selected: Record<string, unknown> = {}
    disclosureItems.value.filter((d) => d.selected).forEach((d) => {
      selected[d.claimName] = d.claimValue
    })
    return selected
  }
  return credential.value.decodedClaims
})

onMounted(async () => {
  const id = route.params.id as string
  const found = credentialsStore.getById(id)
  if (!found) {
    router.replace('/credentials')
    return
  }
  credential.value = found

  if (found.format === 'sd-jwt') {
    try {
      const parsed = await parseSdJwt(found.raw)
      const decoded = decodeDisclosures(parsed.disclosures)
      disclosureItems.value = decoded.map((d) => ({ ...d, selected: true }))
    } catch {
      disclosureItems.value = []
    }
  }
})

async function generate(): Promise<void> {
  if (!credential.value || !walletStore.did) return
  generating.value = true
  error.value = ''

  try {
    const privateKey = walletStore.getPrivateKey()
    if (!privateKey) {
      error.value = 'Wallet key not available'
      return
    }

    if (credential.value.format === 'sd-jwt') {
      const selectedNames = disclosureItems.value
        .filter((d) => d.selected)
        .map((d) => d.claimName)

      generatedVp.value = await createSdJwtPresentation(
        credential.value.raw,
        selectedNames,
        privateKey,
        nonce.value,
        audience.value || 'verifier',
      )
    } else {
      generatedVp.value = await createJsonLdVp({
        credential: credential.value.raw,
        holderDid: walletStore.did,
        holderPrivateKey: privateKey,
        nonce: nonce.value,
      })
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Generation failed'
  } finally {
    generating.value = false
  }
}

async function copyToClipboard(): Promise<void> {
  await navigator.clipboard.writeText(generatedVp.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div class="space-y-3">
    <!-- Back button + title -->
    <div class="flex items-center gap-2">
      <button
        class="rounded-md p-1 hover:bg-slate-800 transition-colors"
        @click="router.push('/credentials')"
      >
        <ArrowLeftIcon class="h-4 w-4 text-slate-400" />
      </button>
      <h2 class="text-sm font-semibold text-white">Present Credential</h2>
    </div>

    <template v-if="credential">
      <!-- Credential info -->
      <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
        <div class="flex items-center gap-2">
          <span
            class="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
            :class="credential.format === 'sd-jwt'
              ? 'bg-indigo-500/20 text-indigo-300'
              : 'bg-emerald-500/20 text-emerald-300'"
          >
            {{ credential.format === 'sd-jwt' ? 'SD-JWT' : 'JSON-LD' }}
          </span>
          <span class="text-xs text-white font-medium truncate">
            {{ credential.types[credential.types.length - 1] }}
          </span>
        </div>
      </div>

      <!-- SD-JWT: Claim checkboxes -->
      <div
        v-if="credential.format === 'sd-jwt' && disclosureItems.length > 0"
        class="rounded-lg border border-slate-700 bg-slate-900 p-3 space-y-2"
      >
        <p class="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
          Select claims to disclose
        </p>
        <label
          v-for="(item, idx) in disclosureItems"
          :key="idx"
          class="flex items-center gap-2 cursor-pointer py-0.5"
        >
          <input
            v-model="item.selected"
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
          />
          <span class="text-[11px] text-slate-300">{{ item.claimName }}</span>
          <span class="text-[10px] text-slate-500 ml-auto truncate max-w-[120px]">
            {{ String(item.claimValue) }}
          </span>
        </label>
      </div>

      <!-- JSON-LD: All claims (read-only) -->
      <div
        v-if="credential.format === 'json-ld'"
        class="rounded-lg border border-slate-700 bg-slate-900 p-3"
      >
        <p class="text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1">
          All claims will be shared
        </p>
        <div
          v-for="(value, key) in credential.decodedClaims"
          :key="String(key)"
          class="flex justify-between py-0.5 text-[11px]"
        >
          <span class="text-slate-400">{{ String(key) }}</span>
          <span class="text-slate-200 truncate max-w-[160px]">{{ String(value) }}</span>
        </div>
      </div>

      <!-- Nonce + Audience -->
      <div class="space-y-2">
        <div>
          <label class="block text-[10px] font-medium text-slate-400 mb-0.5">
            Nonce (from verifier) *
          </label>
          <input
            v-model="nonce"
            type="text"
            placeholder="Enter verifier nonce"
            class="w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
          />
        </div>
        <div v-if="credential.format === 'sd-jwt'">
          <label class="block text-[10px] font-medium text-slate-400 mb-0.5">
            Audience (verifier ID)
          </label>
          <input
            v-model="audience"
            type="text"
            placeholder="Optional verifier identifier"
            class="w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
          />
        </div>
      </div>

      <!-- Preview toggle -->
      <button
        v-if="isReady && !generatedVp"
        class="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
        @click="showPreview = !showPreview"
      >
        <EyeIcon class="h-3.5 w-3.5" />
        {{ showPreview ? 'Hide' : 'Preview' }} what will be shared
      </button>

      <div
        v-if="showPreview && !generatedVp"
        class="rounded-lg border border-slate-700 bg-slate-900 p-3"
      >
        <p class="text-[10px] font-medium text-slate-400 mb-1">Shared claims:</p>
        <div
          v-for="(value, key) in selectedClaims"
          :key="String(key)"
          class="flex justify-between py-0.5 text-[11px]"
        >
          <span class="text-slate-400">{{ String(key) }}</span>
          <span class="text-slate-200 truncate max-w-[160px]">{{ String(value) }}</span>
        </div>
      </div>

      <!-- Generate button -->
      <button
        v-if="!generatedVp"
        :disabled="!isReady || generating"
        class="w-full rounded-md px-3 py-2 text-xs font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="isReady ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-slate-700'"
        @click="generate"
      >
        {{ generating ? 'Generating...' : 'Generate Presentation' }}
      </button>

      <!-- Error -->
      <p v-if="error" class="text-[11px] text-red-400">{{ error }}</p>

      <!-- Result -->
      <div v-if="generatedVp" class="space-y-2">
        <p class="text-[10px] font-medium text-emerald-400 uppercase tracking-wider">
          Presentation Ready
        </p>
        <div class="rounded-lg border border-slate-700 bg-slate-900 p-2 max-h-[120px] overflow-y-auto">
          <pre class="text-[9px] text-slate-300 break-all whitespace-pre-wrap font-mono">{{ generatedVp }}</pre>
        </div>
        <button
          class="w-full flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
          @click="copyToClipboard"
        >
          <component :is="copied ? CheckIcon : ClipboardIcon" class="h-3.5 w-3.5" />
          {{ copied ? 'Copied!' : 'Copy to Clipboard' }}
        </button>
        <button
          class="w-full rounded-md bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
          @click="generatedVp = ''; showPreview = false"
        >
          Generate Another
        </button>
      </div>
    </template>
  </div>
</template>
