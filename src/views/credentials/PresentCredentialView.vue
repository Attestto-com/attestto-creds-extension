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
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <!-- Back button + title -->
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <button
        style="border-radius: var(--ext-radius-md); padding: 0.25rem; cursor: pointer; background: none; border: none; color: var(--ext-text-secondary)"
        @click="router.push('/credentials')"
      >
        <ArrowLeftIcon style="width: 1rem; height: 1rem" />
      </button>
      <h2 style="font-size: var(--ext-text-md); font-weight: 600; color: var(--ext-text-primary)">Present Credential</h2>
    </div>

    <template v-if="credential">
      <!-- Credential info -->
      <div class="ext-card">
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <span
            class="ext-badge"
            :class="credential.format === 'sd-jwt' ? 'ext-badge--brand' : 'ext-badge--success'"
            style="font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em"
          >
            {{ credential.format === 'sd-jwt' ? 'SD-JWT' : 'JSON-LD' }}
          </span>
          <span style="font-size: var(--ext-text-xs); color: var(--ext-text-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
            {{ credential.types[credential.types.length - 1] }}
          </span>
        </div>
      </div>

      <!-- SD-JWT: Claim checkboxes -->
      <div
        v-if="credential.format === 'sd-jwt' && disclosureItems.length > 0"
        class="ext-card"
        style="display: flex; flex-direction: column; gap: 0.5rem"
      >
        <p class="ext-detail__label" style="margin-bottom: 0">Select claims to disclose</p>
        <label
          v-for="(item, idx) in disclosureItems"
          :key="idx"
          style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; padding: 0.125rem 0"
        >
          <input v-model="item.selected" type="checkbox" style="width: 0.875rem; height: 0.875rem" />
          <span style="font-size: var(--ext-text-xs); color: var(--ext-text-secondary)">{{ item.claimName }}</span>
          <span style="font-size: var(--ext-text-2xs); color: var(--ext-text-muted); margin-left: auto; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
            {{ String(item.claimValue) }}
          </span>
        </label>
      </div>

      <!-- JSON-LD: All claims (read-only) -->
      <div v-if="credential.format === 'json-ld'" class="ext-card">
        <p class="ext-detail__label">All claims will be shared</p>
        <div
          v-for="(value, key) in credential.decodedClaims"
          :key="String(key)"
          style="display: flex; justify-content: space-between; padding: 0.125rem 0; font-size: var(--ext-text-xs)"
        >
          <span style="color: var(--ext-text-secondary)">{{ String(key) }}</span>
          <span style="color: var(--ext-text-primary); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ String(value) }}</span>
        </div>
      </div>

      <!-- Nonce + Audience -->
      <div style="display: flex; flex-direction: column; gap: 0.5rem">
        <div>
          <label class="ext-detail__label" style="display: block; margin-bottom: 0.125rem">Nonce (from verifier) *</label>
          <input
            v-model="nonce"
            type="text"
            placeholder="Enter verifier nonce"
            style="width: 100%; border-radius: var(--ext-radius-md); border: 1px solid var(--ext-border-subtle); background: var(--ext-bg-surface-hover); padding: 0.375rem 0.625rem; font-size: var(--ext-text-xs); color: var(--ext-text-primary); outline: none"
          />
        </div>
        <div v-if="credential.format === 'sd-jwt'">
          <label class="ext-detail__label" style="display: block; margin-bottom: 0.125rem">Audience (verifier ID)</label>
          <input
            v-model="audience"
            type="text"
            placeholder="Optional verifier identifier"
            style="width: 100%; border-radius: var(--ext-radius-md); border: 1px solid var(--ext-border-subtle); background: var(--ext-bg-surface-hover); padding: 0.375rem 0.625rem; font-size: var(--ext-text-xs); color: var(--ext-text-primary); outline: none"
          />
        </div>
      </div>

      <!-- Preview toggle -->
      <button
        v-if="isReady && !generatedVp"
        style="display: flex; align-items: center; gap: 0.25rem; font-size: var(--ext-text-xs); color: var(--ext-brand-secondary); cursor: pointer; background: none; border: none"
        @click="showPreview = !showPreview"
      >
        <EyeIcon style="width: 0.875rem; height: 0.875rem" />
        {{ showPreview ? 'Hide' : 'Preview' }} what will be shared
      </button>

      <div v-if="showPreview && !generatedVp" class="ext-card">
        <p class="ext-detail__label">Shared claims:</p>
        <div
          v-for="(value, key) in selectedClaims"
          :key="String(key)"
          style="display: flex; justify-content: space-between; padding: 0.125rem 0; font-size: var(--ext-text-xs)"
        >
          <span style="color: var(--ext-text-secondary)">{{ String(key) }}</span>
          <span style="color: var(--ext-text-primary); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ String(value) }}</span>
        </div>
      </div>

      <!-- Generate button -->
      <button
        v-if="!generatedVp"
        class="ext-btn ext-btn--md"
        :class="isReady ? 'ext-btn--primary' : 'ext-btn--ghost'"
        style="width: 100%"
        :disabled="!isReady || generating"
        @click="generate"
      >
        {{ generating ? 'Generating...' : 'Generate Presentation' }}
      </button>

      <!-- Error -->
      <p v-if="error" style="font-size: var(--ext-text-xs); color: var(--ext-error)">{{ error }}</p>

      <!-- Result -->
      <div v-if="generatedVp" style="display: flex; flex-direction: column; gap: 0.5rem">
        <p class="ext-detail__label" style="color: var(--ext-success)">Presentation Ready</p>
        <div class="ext-card" style="max-height: 120px; overflow-y: auto; padding: 0.5rem">
          <pre style="font-size: 9px; color: var(--ext-text-secondary); word-break: break-all; white-space: pre-wrap; font-family: monospace; margin: 0">{{ generatedVp }}</pre>
        </div>
        <button class="ext-btn ext-btn--primary ext-btn--md" style="width: 100%" @click="copyToClipboard">
          <component :is="copied ? CheckIcon : ClipboardIcon" style="width: 0.875rem; height: 0.875rem" />
          {{ copied ? 'Copied!' : 'Copy to Clipboard' }}
        </button>
        <button class="ext-btn ext-btn--ghost ext-btn--sm" style="width: 100%" @click="generatedVp = ''; showPreview = false">
          Generate Another
        </button>
      </div>
    </template>
  </div>
</template>
