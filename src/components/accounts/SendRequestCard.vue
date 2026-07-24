<script setup lang="ts">
/**
 * DEMO — peer Pay / Request card (Venmo-style sliding steps).
 *
 * The counterparty is addressed by ALIAS only (their Attestto ID → did:sns).
 * The sender never needs the recipient's account number. Because routing is by
 * DID, the payer picks WHICH of their own accounts funds it, and the requester
 * picks WHICH of their accounts receives — accounts are fungible endpoints
 * behind one identity (account abstraction via DID).
 *
 * Confirm sends a signed DID message to the recipient's Inbox. Mocked.
 */
import { ref, computed } from 'vue'
import {
  ArrowRightIcon,
  ChevronLeftIcon,
  PaperAirplaneIcon,
  CheckCircleIcon,
  ArrowUpRightIcon,
  ArrowDownLeftIcon,
} from '@heroicons/vue/24/outline'
import { demoAccounts, formatIban } from '@/config/demo-accounts'
import {
  CURRENCIES,
  formatMoney,
  sendPeerMessage,
  type PayCurrency,
  type PeerMessageResult,
} from '@/api/pay-client'

type Step = 'alias' | 'amount' | 'action' | 'sending' | 'sent'
const step = ref<Step>('alias')

const toAlias = ref('')
const amount = ref<number | null>(null)
const currency = ref<PayCurrency>('CRC')
const kind = ref<'pay' | 'request'>('pay')
const fromDid = ref(demoAccounts[0]?.did ?? '')
const result = ref<PeerMessageResult | null>(null)

const cleanAlias = computed(() => toAlias.value.trim().replace(/\s+/g, '').toLowerCase())
const canContinueAlias = computed(() => cleanAlias.value.length > 1)
const canContinueAmount = computed(() => !!amount.value && amount.value > 0)
const selectedAccount = computed(
  () => demoAccounts.find((a) => a.did === fromDid.value) ?? demoAccounts[0],
)

function reset(): void {
  step.value = 'alias'
  toAlias.value = ''
  amount.value = null
  currency.value = 'CRC'
  kind.value = 'pay'
  result.value = null
}

async function confirm(): Promise<void> {
  if (!amount.value || !selectedAccount.value) return
  step.value = 'sending'
  result.value = await sendPeerMessage(
    kind.value,
    cleanAlias.value,
    amount.value,
    currency.value,
    selectedAccount.value.did,
  )
  step.value = 'sent'
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
    <!-- STEP 1: recipient alias -->
    <div v-if="step === 'alias'" class="p-3">
      <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Pagar o solicitar
      </p>
      <label class="mb-1 block text-[10px] text-slate-400">¿A quién? (usuario Attestto)</label>
      <div class="flex items-center rounded-md border border-slate-700 bg-slate-950 px-2">
        <span class="text-xs text-slate-600">@</span>
        <input
          v-model="toAlias"
          type="text"
          autocapitalize="none"
          spellcheck="false"
          placeholder="destinatario"
          class="w-full bg-transparent px-1.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none"
          @keyup.enter="canContinueAlias && (step = 'amount')"
        />
      </div>
      <p class="mt-1.5 text-[10px] leading-relaxed text-slate-500">
        Enviás a su identidad, no a un número de cuenta. Él decide en cuál de sus cuentas lo recibe.
      </p>
      <button
        class="mt-3 flex w-full items-center justify-center gap-1 rounded-lg px-4 py-2.5 text-xs font-semibold text-white"
        :class="canContinueAlias ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-slate-700 text-slate-400'"
        :disabled="!canContinueAlias"
        @click="step = 'amount'"
      >
        Continuar <ArrowRightIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- STEP 2: amount + currency -->
    <div v-else-if="step === 'amount'" class="p-3">
      <button class="mb-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200" @click="step = 'alias'">
        <ChevronLeftIcon class="h-4 w-4" /> @{{ cleanAlias }}
      </button>
      <label class="mb-1 block text-[10px] text-slate-400">Monto y moneda</label>
      <div class="flex gap-2">
        <div class="flex flex-1 items-center rounded-md border border-slate-700 bg-slate-950 px-2">
          <input
            v-model.number="amount"
            type="number"
            min="0"
            inputmode="decimal"
            placeholder="0"
            class="w-full bg-transparent px-1.5 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none"
            @keyup.enter="canContinueAmount && (step = 'action')"
          />
        </div>
        <select
          v-model="currency"
          class="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-white focus:outline-none"
        >
          <option v-for="c in CURRENCIES" :key="c.code" :value="c.code">{{ c.code }}</option>
        </select>
      </div>
      <button
        class="mt-3 flex w-full items-center justify-center gap-1 rounded-lg px-4 py-2.5 text-xs font-semibold text-white"
        :class="canContinueAmount ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-slate-700 text-slate-400'"
        :disabled="!canContinueAmount"
        @click="step = 'action'"
      >
        Continuar <ArrowRightIcon class="h-4 w-4" />
      </button>
    </div>

    <!-- STEP 3: pay | request + source/receive account + confirm -->
    <div v-else-if="step === 'action'" class="p-3">
      <button class="mb-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200" @click="step = 'amount'">
        <ChevronLeftIcon class="h-4 w-4" /> {{ formatMoney(amount ?? 0, currency) }} · @{{ cleanAlias }}
      </button>

      <!-- Pay / Request toggle -->
      <div class="mb-3 grid grid-cols-2 gap-2">
        <button
          class="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
          :class="kind === 'pay' ? 'border-indigo-500 bg-indigo-950/50 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-800'"
          @click="kind = 'pay'"
        >
          <ArrowUpRightIcon class="h-4 w-4" /> Pagar
        </button>
        <button
          class="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
          :class="kind === 'request' ? 'border-emerald-500 bg-emerald-950/50 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-800'"
          @click="kind = 'request'"
        >
          <ArrowDownLeftIcon class="h-4 w-4" /> Solicitar
        </button>
      </div>

      <!-- Which of MY accounts (source when paying, receive when requesting) -->
      <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {{ kind === 'pay' ? 'Pagar desde' : 'Recibir en' }}
      </p>
      <div class="space-y-2">
        <label
          v-for="acct in demoAccounts"
          :key="acct.did"
          class="flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors"
          :class="fromDid === acct.did ? 'border-indigo-500 bg-indigo-950/40' : 'border-slate-700 hover:bg-slate-800'"
        >
          <input v-model="fromDid" type="radio" :value="acct.did" class="accent-indigo-500" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-white">{{ acct.label }}</p>
            <p class="font-mono text-[10px] text-slate-400">{{ formatIban(acct.iban) }}</p>
          </div>
        </label>
      </div>

      <button
        class="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold text-white"
        :class="kind === 'pay' ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-emerald-600 hover:bg-emerald-500'"
        @click="confirm"
      >
        <PaperAirplaneIcon class="h-4 w-4" />
        {{ kind === 'pay' ? 'Firmar y pagar' : 'Solicitar' }} {{ formatMoney(amount ?? 0, currency) }}
      </button>
      <p class="mt-1.5 text-center text-[10px] text-slate-500">
        Se envía un mensaje firmado a la identidad de @{{ cleanAlias }}.
      </p>
    </div>

    <!-- SENDING -->
    <div v-else-if="step === 'sending'" class="p-5 text-center">
      <div class="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
      <p class="text-xs font-medium text-white">Firmando y enviando…</p>
      <p class="mt-1 text-[10px] text-slate-500">Entregando a la identidad de @{{ cleanAlias }}</p>
    </div>

    <!-- SENT -->
    <div v-else class="p-4 text-center">
      <CheckCircleIcon class="mx-auto h-9 w-9" :class="kind === 'pay' ? 'text-indigo-400' : 'text-emerald-400'" />
      <p class="mt-2 text-xs font-semibold text-white">
        {{ kind === 'pay' ? 'Pago enviado' : 'Solicitud enviada' }}
      </p>
      <p class="text-sm font-bold" :class="kind === 'pay' ? 'text-indigo-300' : 'text-emerald-300'">
        {{ formatMoney(amount ?? 0, currency) }} · @{{ cleanAlias }}
      </p>
      <p class="mt-1 font-mono text-[10px] text-slate-500">{{ result?.reference }}</p>
      <p class="mt-1 text-[10px] text-slate-500">
        Aparecerá en el Inbox de @{{ cleanAlias }} para {{ kind === 'pay' ? 'confirmar recepción' : 'aprobar el pago' }}.
      </p>
      <button
        class="mt-3 w-full rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
        @click="reset"
      >
        Listo
      </button>
    </div>
  </div>
</template>
