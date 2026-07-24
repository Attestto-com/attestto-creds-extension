<script setup lang="ts">
/**
 * DEMO — Attestto Pay checkout for the Nicoya ₡530 trámite.
 *
 * Stripe-like flow, but the payment method is a DID signature:
 *   review → sign with DID → backend settles (Circle/Solana, internal) → receipt
 *
 * The user only ever sees their identity + IBAN + amount. Solana and the Circle
 * custodial wallet are never surfaced. Everything here is mocked (no backend).
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  ShieldCheckIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  BuildingLibraryIcon,
} from '@heroicons/vue/24/outline'
import { demoAccounts, formatIban } from '@/config/demo-accounts'
import {
  NICOYA_CONSTANCIA,
  formatCRC,
  signPayIntent,
  submitPayIntent,
  type PaySettlement,
} from '@/api/pay-client'

const router = useRouter()
const tramite = NICOYA_CONSTANCIA

type Step = 'review' | 'signing' | 'settling' | 'done'
const step = ref<Step>('review')
const selectedDid = ref(demoAccounts[0]?.did ?? '')
const settlement = ref<PaySettlement | null>(null)

const selected = computed(() => demoAccounts.find((a) => a.did === selectedDid.value) ?? demoAccounts[0])

const busy = computed(() => step.value === 'signing' || step.value === 'settling')

async function pay(): Promise<void> {
  if (!selected.value) return
  const intent = {
    tramiteId: tramite.id,
    amountCRC: tramite.total,
    signerDid: selected.value.did,
    iban: selected.value.iban,
  }
  step.value = 'signing'
  const signature = await signPayIntent(intent)
  step.value = 'settling'
  settlement.value = await submitPayIntent(intent, signature)
  step.value = 'done'
}

function back(): void {
  router.push({ name: 'accounts' })
}
</script>

<template>
  <div class="space-y-4">
    <button class="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200" @click="back">
      <ChevronLeftIcon class="h-4 w-4" /> Cuentas
    </button>

    <!-- Trámite summary -->
    <div class="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <p class="text-sm font-semibold text-white">{{ tramite.title }}</p>

      <!-- Merchant / payee -->
      <div class="mt-1.5 flex items-start gap-2">
        <BuildingLibraryIcon class="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
        <div class="min-w-0 flex-1">
          <p class="text-[11px] font-medium text-slate-200">{{ tramite.authority }}</p>
          <p class="font-mono text-[9px] text-slate-500">
            Céd. jurídica {{ tramite.authorityCedula }}
          </p>
        </div>
      </div>

      <!-- Verified state-entity badges -->
      <div v-if="tramite.authorityKind === 'state'" class="mt-2 flex flex-wrap gap-1.5">
        <span class="inline-flex items-center gap-1 rounded-full border border-sky-700/60 bg-sky-950/40 px-2 py-0.5 text-[9px] font-medium text-sky-300">
          <BuildingLibraryIcon class="h-3 w-3" /> Entidad estatal
        </span>
        <span class="inline-flex items-center gap-1 rounded-full border border-emerald-700/60 bg-emerald-950/40 px-2 py-0.5 text-[9px] font-medium text-emerald-300">
          <ShieldCheckIcon class="h-3 w-3" /> Identidad verificada
        </span>
      </div>

      <div class="mt-3 space-y-1.5 border-t border-slate-800 pt-3">
        <div
          v-for="line in tramite.lines"
          :key="line.label"
          class="flex items-start justify-between gap-3 text-[11px]"
        >
          <span class="text-slate-400">{{ line.label }}</span>
          <span class="shrink-0 font-mono text-slate-300">{{ formatCRC(line.amountCRC) }}</span>
        </div>
        <div class="flex justify-between border-t border-slate-800 pt-2 text-xs font-semibold">
          <span class="text-white">Total</span>
          <span class="text-white">{{ formatCRC(tramite.total) }}</span>
        </div>
      </div>
    </div>

    <!-- REVIEW: pick paying identity + pay -->
    <template v-if="step === 'review'">
      <div>
        <p class="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Pagar con
        </p>
        <div class="space-y-2">
          <label
            v-for="acct in demoAccounts"
            :key="acct.did"
            class="flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors"
            :class="selectedDid === acct.did
              ? 'border-indigo-500 bg-indigo-950/40'
              : 'border-slate-700 bg-slate-900 hover:bg-slate-800'"
          >
            <input v-model="selectedDid" type="radio" :value="acct.did" class="accent-indigo-500" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium text-white">{{ acct.label }}</p>
              <p class="font-mono text-[10px] text-slate-400">{{ formatIban(acct.iban) }}</p>
            </div>
          </label>
        </div>
      </div>

      <button
        class="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500"
        @click="pay"
      >
        <ShieldCheckIcon class="h-5 w-5" />
        Firmar y pagar {{ formatCRC(tramite.total) }}
      </button>
      <p class="text-center text-[10px] leading-relaxed text-slate-500">
        Firmás con tu identidad Attestto. Nadie más puede autorizar este pago.
      </p>
    </template>

    <!-- SIGNING / SETTLING: progress -->
    <div v-else-if="busy" class="rounded-lg border border-slate-700 bg-slate-900 p-5 text-center">
      <div class="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
      <p class="text-xs font-medium text-white">
        {{ step === 'signing' ? 'Firmando con tu identidad…' : 'Procesando el pago…' }}
      </p>
      <p class="mt-1 text-[10px] text-slate-500">
        {{ step === 'signing' ? selected?.label : 'Confirmando con la red de pago' }}
      </p>
    </div>

    <!-- DONE: receipt -->
    <div v-else-if="step === 'done'" class="space-y-3">
      <div class="rounded-lg border border-emerald-700/60 bg-emerald-950/30 p-4 text-center">
        <CheckCircleIcon class="mx-auto h-10 w-10 text-emerald-400" />
        <p class="mt-2 text-sm font-semibold text-white">Pago realizado</p>
        <p class="text-lg font-bold text-emerald-400">{{ formatCRC(tramite.total) }}</p>
      </div>
      <div class="space-y-1.5 rounded-lg border border-slate-700 bg-slate-900 p-3 text-[11px]">
        <div class="flex justify-between">
          <span class="text-slate-400">Referencia</span>
          <span class="font-mono text-slate-200">{{ settlement?.reference }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-slate-400">Trámite</span>
          <span class="text-slate-200">{{ tramite.title }}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="shrink-0 text-slate-400">Pagado a</span>
          <span class="truncate text-slate-200">{{ tramite.authority }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-slate-400">Pagado por</span>
          <span class="truncate pl-2 text-slate-200">{{ selected?.label }}</span>
        </div>
      </div>
      <button
        class="w-full rounded-lg border border-slate-700 px-4 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
        @click="back"
      >
        Volver a cuentas
      </button>
    </div>
  </div>
</template>
