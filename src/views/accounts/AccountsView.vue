<script setup lang="ts">
/**
 * DEMO — Accounts screen for the Attestto Pay walkthrough.
 *
 * Shows the user's Attestto identities (added by alias, in Settings) surfaced as
 * a familiar IBAN — never a Solana / Circle address, never a balance. The main
 * interaction is the Pay/Request card (send a signed DID message to an alias).
 * A trámite shortcut demonstrates paying a verified state entity.
 */
import { useRouter } from 'vue-router'
import {
  FingerPrintIcon,
  IdentificationIcon,
  BanknotesIcon,
  ArrowRightIcon,
} from '@heroicons/vue/24/outline'
import { demoAccounts, formatIban } from '@/config/demo-accounts'
import { formatCRC, NICOYA_CONSTANCIA } from '@/api/pay-client'
import SendRequestCard from '@/components/accounts/SendRequestCard.vue'

const router = useRouter()

function payTramite(): void {
  router.push({ name: 'pay-tramite' })
}
</script>

<template>
  <div class="space-y-4">
    <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
      Mis cuentas
    </p>

    <!-- Account cards: identity + IBAN (no balance) -->
    <div
      v-for="acct in demoAccounts"
      :key="acct.did"
      class="rounded-lg border border-slate-700 bg-slate-900 p-3"
    >
      <div class="flex items-center gap-3">
        <div class="relative">
          <FingerPrintIcon class="h-6 w-6 text-indigo-400" />
          <span class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-white">{{ acct.label }}</p>
          <p class="mt-0.5 font-mono text-[10px] tracking-wide text-slate-400">
            {{ formatIban(acct.iban) }}
          </p>
        </div>
        <IdentificationIcon class="h-5 w-5 shrink-0 text-slate-600" />
      </div>
    </div>

    <!-- Pay / Request by alias (the DID-message primitive) -->
    <SendRequestCard />

    <!-- Pay a trámite (verified state entity) -->
    <button
      class="flex w-full items-center gap-3 rounded-lg border border-indigo-700/60 bg-indigo-950/40 p-3 text-left transition-colors hover:bg-indigo-900/40"
      @click="payTramite"
    >
      <BanknotesIcon class="h-6 w-6 shrink-0 text-indigo-300" />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-semibold text-white">Pagar un trámite</p>
        <p class="truncate text-[10px] text-slate-400">
          {{ NICOYA_CONSTANCIA.title }} · {{ NICOYA_CONSTANCIA.authority }}
        </p>
      </div>
      <span class="text-sm font-bold text-white">{{ formatCRC(NICOYA_CONSTANCIA.total) }}</span>
      <ArrowRightIcon class="h-4 w-4 shrink-0 text-slate-500" />
    </button>
  </div>
</template>
