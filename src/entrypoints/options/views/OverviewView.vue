<script setup lang="ts">
/**
 * First-install landing. `background.ts` opens this tab on install, so for most
 * users it is the FIRST thing the extension ever shows them.
 *
 * It therefore leads with the one action that matters and asks for nothing
 * else: set up the passkey. That single call mints the vault AND a Tier 1
 * `did:jwk`, so when the user next lands on any site there is nothing left to
 * configure — they just sign in. Setup used to be reachable only from the popup
 * or, worse, from inside a site's approval window, where a 30-second request
 * timeout was running while the user was asked to invent a password.
 *
 * The CTA here was previously `<a to="/setup">` — a `<router-link>` prop on a
 * plain anchor, so it rendered with no `href` and did nothing at all. There is
 * no router in this entrypoint and no `/setup` route to reach; the setup call
 * belongs here, in the page, which is what it now is.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldCheckIcon, FingerPrintIcon, LockClosedIcon, EyeSlashIcon, ArrowRightIcon, ArrowTopRightOnSquareIcon, CheckCircleIcon } from '@heroicons/vue/24/outline'
import { listPins, type PinRecord } from '@/utils/pin-store'
import { useWalletStore } from '@/stores/wallet'
import { readPublicVault } from '@/utils/vault'
import { hasIdentity as publicVaultHasIdentity } from '@/utils/identity-presence'
import { APP_VERSION } from '@/config/app'

defineEmits<{ goto: [tab: 'overview' | 'security' | 'privacy'] }>()

const { t } = useI18n()
const wallet = useWalletStore()
const pins = ref<PinRecord[]>([])

/**
 * Read through the CANONICAL predicate rather than re-deriving it here.
 *
 * This used to be `wallet.linkedIdentities.length > 0`, which is not the same
 * question: `setup()` mints a root `did` and no linked identity, so a freshly
 * set-up wallet still reported itself as not set up and kept offering the CTA.
 * `hasIdentity` counts a root `did`, a `holderDid`, or a linked identity, and
 * is the same predicate the page-facing readiness signal uses — so the two
 * cannot drift into disagreeing about what "set up" means.
 */
const setUp = ref(false)
const trustedCount = computed(() => pins.value.length)

type SetupState = 'idle' | 'working' | 'done'
const state = ref<SetupState>('idle')
const setupError = ref<string | null>(null)

async function refreshSetUp(): Promise<void> {
  setUp.value = publicVaultHasIdentity(await readPublicVault())
}

onMounted(async () => {
  await wallet.loadPublicData()
  await refreshSetUp()
  try {
    pins.value = await listPins()
  } catch {
    pins.value = []
  }
})

/**
 * The whole of first-run.
 *
 * Expect the authenticator to appear TWICE: once to create the credential, once
 * to evaluate PRF over it. That is how browsers expose the extension — the
 * registration response announces PRF, only an assertion yields the secret —
 * and it is not something this code can collapse.
 */
async function setUpPasskey(): Promise<void> {
  state.value = 'working'
  setupError.value = null
  try {
    await wallet.setup()
    await refreshSetUp()
    state.value = 'done'
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Setup failed'
    if (msg.startsWith('PRF_UNSUPPORTED')) {
      setupError.value = t('overview.identity.unsupported')
    } else if (
      msg.startsWith('Passkey registration cancelled') ||
      (err instanceof DOMException && err.name === 'NotAllowedError')
    ) {
      setupError.value = t('overview.identity.cancelled')
    } else {
      setupError.value = msg
    }
    state.value = 'idle'
  }
}

/**
 * Setup is the only reason this tab was opened, so once it succeeds the tab has
 * no further job — but it closes on a CLICK, not on a timer.
 *
 * It used to close itself 2.5s after success. Closing a tab hands focus to
 * whichever tab happens to be behind it, so "you are done" and "you are now
 * looking at something unrelated" arrived as a single event and read as being
 * redirected somewhere. The disorientation is inherent to closing a tab out
 * from under someone, not a delay that could be tuned.
 *
 * `window.close()` is not used: it is a no-op for a tab the extension opened via
 * `chrome.tabs.create` rather than one script opened. Removing our own tab id is
 * the path that actually works. Best-effort — a tab that will not close is not a
 * failure worth reporting, and the success state reads fine on its own.
 */
function closeTab(): void {
  try {
    chrome.tabs?.getCurrent?.((tab) => {
      if (tab?.id != null) void chrome.tabs.remove(tab.id)
    })
  } catch {
    /* leaving the tab open is harmless */
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-6 lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">
    <header>
      <h1 class="text-3xl font-semibold tracking-tight text-[#f1f4f8]">{{ t('overview.title') }}</h1>
      <p class="mt-2 text-sm text-[#a8b4c4]">
        {{ setUp ? t('overview.subtitle') : t('overview.subtitleFirstRun') }}
      </p>
    </header>

    <!--
      Order follows what the visitor has to DO. Before setup the passkey card is
      the first thing on the page; afterwards anti-phishing — always on, nothing
      to configure — leads again.

      Done with CSS `order` on a flex column rather than by rendering the cards
      in two branches. The branch version duplicated both blocks, and a mutation
      test caught what that costs: an edit applied to one copy left the other
      untouched and the page still worked, so the copies could silently diverge.
    -->
    <div class="flex flex-col gap-6">
    <!--
      Identity card. When the wallet is NOT set up this is the whole page as far
      as the user is concerned — the header above says so and it renders FIRST
      (see the ordering wrapper below), because "set up your passkey" is the only
      thing a first-install visitor should have to read.
    -->
    <section :class="['rounded-xl border border-[#243044] bg-[#111a28] p-6 shadow-sm', setUp ? 'order-2' : 'order-1']">
      <div class="flex items-start gap-4">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#3b82a0]/15">
          <CheckCircleIcon v-if="state === 'done'" class="size-5 text-emerald-400" />
          <FingerPrintIcon v-else class="size-5 text-[#5a9db8]" />
        </div>
        <div class="flex-1">
          <h2 class="text-base font-semibold text-[#f1f4f8]">
            {{ state === 'done' ? t('overview.identity.doneTitle') : t('overview.identity.title') }}
          </h2>

          <template v-if="state === 'done'">
            <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('overview.identity.doneBody') }}</p>
            <button
              type="button"
              class="mt-3 inline-flex items-center gap-2 rounded-md bg-[#3b82a0] px-4 py-2 text-sm font-medium text-white hover:bg-[#4a9ab8]"
              @click="closeTab"
            >
              {{ t('overview.identity.done') }}
            </button>
          </template>

          <template v-else-if="setUp">
            <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('overview.identity.activeBody') }}</p>
            <ul v-if="wallet.linkedIdentities.length" class="mt-2 space-y-1">
              <li v-for="i in wallet.linkedIdentities" :key="i.did" class="text-xs font-mono text-[#cfd8e4]">{{ i.label }}</li>
            </ul>
          </template>

          <template v-else>
            <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('overview.identity.upgradeBody') }}</p>
            <button
              type="button"
              :disabled="state === 'working'"
              class="mt-3 inline-flex items-center gap-2 rounded-md bg-[#3b82a0] px-4 py-2 text-sm font-medium text-white hover:bg-[#4a9ab8] disabled:opacity-50"
              @click="setUpPasskey"
            >
              <FingerPrintIcon class="size-4" />
              {{ state === 'working' ? t('overview.identity.working') : t('overview.identity.setup') }}
            </button>
            <p class="mt-2 text-xs text-[#8a97a8]">{{ t('overview.identity.twoPrompts') }}</p>
            <p v-if="setupError" class="mt-2 text-xs text-red-300">{{ setupError }}</p>
          </template>
        </div>
      </div>
    </section>
    <!-- Anti-phishing card -->
    <section :class="['rounded-xl border border-[#243044] bg-[#111a28] p-6 shadow-sm', setUp ? 'order-1' : 'order-2']">
      <div class="flex items-start gap-4">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
          <ShieldCheckIcon class="size-5 text-emerald-400" />
        </div>
        <div class="flex-1">
          <h2 class="text-base font-semibold text-[#f1f4f8]">{{ t('overview.protection.title') }}</h2>
          <p class="mt-1 text-sm text-[#a8b4c4]">{{ t('overview.protection.body') }}</p>
          <p class="mt-3 text-xs text-[#8a97a8]">{{ t('overview.protection.trustedCount', { n: trustedCount }, trustedCount) }}</p>
          <button
            type="button"
            class="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#5a9db8] hover:text-[#9ecbe0]"
            @click="$emit('goto', 'security')"
          >
            {{ t('overview.protection.manage') }}
            <ArrowRightIcon class="size-4" />
          </button>
        </div>
      </div>
    </section>
    </div>

    <!-- Quick links to sub-pages -->
    <section class="grid gap-3 sm:grid-cols-2">
      <button
        type="button"
        class="flex items-start gap-3 rounded-xl border border-[#243044] bg-[#111a28] p-4 text-left shadow-sm hover:border-[#3b82a0]/60 hover:bg-[#141e2e]"
        @click="$emit('goto', 'security')"
      >
        <LockClosedIcon class="size-5 text-[#8a97a8]" />
        <div>
          <p class="text-sm font-medium text-[#f1f4f8]">{{ t('settingsNav.security') }}</p>
          <p class="mt-0.5 text-xs text-[#a8b4c4]">{{ t('overview.cards.security') }}</p>
        </div>
      </button>
      <button
        type="button"
        class="flex items-start gap-3 rounded-xl border border-[#243044] bg-[#111a28] p-4 text-left shadow-sm hover:border-[#3b82a0]/60 hover:bg-[#141e2e]"
        @click="$emit('goto', 'privacy')"
      >
        <EyeSlashIcon class="size-5 text-[#8a97a8]" />
        <div>
          <p class="text-sm font-medium text-[#f1f4f8]">{{ t('settingsNav.privacy') }}</p>
          <p class="mt-0.5 text-xs text-[#a8b4c4]">{{ t('overview.cards.privacy') }}</p>
        </div>
      </button>
    </section>

    <!-- Resources & about -->
    <section class="grid gap-3 sm:grid-cols-2">
      <a
        href="https://attestto.com"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-3 rounded-xl border border-[#243044] bg-[#111a28] p-4 text-left shadow-sm hover:border-[#3b82a0]/60 hover:bg-[#141e2e]"
      >
        <ArrowTopRightOnSquareIcon class="size-5 text-[#8a97a8]" />
        <span class="text-sm font-medium text-[#f1f4f8]">{{ t('overview.resources.dashboard') }}</span>
        <ArrowTopRightOnSquareIcon class="ml-auto size-4 text-[#8a97a8]" />
      </a>
    </section>

    <p class="text-center text-xs text-[#8a97a8]">
      {{ t('overview.resources.version', { version: APP_VERSION }) }}
    </p>
  </div>
</template>
