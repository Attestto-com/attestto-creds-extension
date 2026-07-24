<script setup lang="ts">
/**
 * DEMO — Accounts screen for the Attestto Pay walkthrough.
 *
 * Shows the user's Attestto identities added by alias, each surfaced as a
 * familiar IBAN (never a Solana / Circle address). Users add an identity by
 * typing an Attestto username; they cannot enter a raw account number.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  FingerPrintIcon,
  PlusIcon,
  BanknotesIcon,
  ArrowRightIcon,
  IdentificationIcon,
} from '@heroicons/vue/24/outline'
import { demoAccounts, addByAlias, formatIban } from '@/config/demo-accounts'
import { formatCRC, NICOYA_CONSTANCIA } from '@/api/pay-client'

const router = useRouter()
const aliasInput = ref('')
const addError = ref('')

function onAdd(): void {
  addError.value = ''
  const alias = aliasInput.value.trim()
  if (!alias) return
  const added = addByAlias(alias)
  if (!added) {
    addError.value = 'Esa identidad ya está agregada.'
    return
  }
  aliasInput.value = ''
}

function payTramite(): void {
  router.push({ name: 'pay-tramite' })
}
</script>

<template>
  <div class="space-y-4">
    <p class="px-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
      Mis cuentas
    </p>

    <!-- Account cards: identity + IBAN -->
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

    <!-- Add identity by alias -->
    <div class="rounded-lg border border-dashed border-slate-700 bg-slate-900/50 p-3">
      <p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Agregar identidad Attestto
      </p>
      <div class="flex gap-2">
        <div class="flex flex-1 items-center rounded-md border border-slate-700 bg-slate-950 px-2">
          <span class="text-xs text-slate-600">@</span>
          <input
            v-model="aliasInput"
            type="text"
            inputmode="text"
            autocapitalize="none"
            spellcheck="false"
            placeholder="tu-usuario"
            class="w-full bg-transparent px-1.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none"
            @keyup.enter="onAdd"
          />
        </div>
        <button
          class="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500"
          @click="onAdd"
        >
          <PlusIcon class="h-4 w-4" />
          Agregar
        </button>
      </div>
      <p v-if="addError" class="mt-1.5 text-[10px] text-amber-400">{{ addError }}</p>
      <p class="mt-1.5 text-[10px] leading-relaxed text-slate-500">
        Ingresás el usuario de tu Attestto ID. La cuenta se muestra como IBAN.
      </p>
    </div>

    <!-- Pay a trámite CTA -->
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
