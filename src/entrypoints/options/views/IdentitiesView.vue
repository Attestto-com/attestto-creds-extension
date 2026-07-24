<script setup lang="ts">
/**
 * DEMO — Settings › Identities.
 *
 * Adding an Attestto ID lives here (moved off the popup's Accounts screen).
 * The user adds an identity by ALIAS (their Attestto username); it is surfaced
 * as an IBAN. No raw account numbers, no balances.
 */
import { ref } from 'vue'
import { FingerPrintIcon, PlusIcon } from '@heroicons/vue/24/outline'
import { demoAccounts, addByAlias, formatIban } from '@/config/demo-accounts'

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
</script>

<template>
  <section class="space-y-6 text-[#f1f4f8]">
    <div>
      <h2 class="text-lg font-semibold">Identidades</h2>
      <p class="mt-1 text-sm text-[#a8b4c4]">
        Agregá una identidad Attestto por su usuario. La cuenta se muestra como IBAN;
        nunca ingresás un número de cuenta.
      </p>
    </div>

    <!-- Add by alias -->
    <div class="rounded-xl border border-dashed border-[#2c3a4f] bg-[#111a28] p-4">
      <p class="mb-2 text-xs font-medium uppercase tracking-wider text-[#8a97a8]">
        Agregar identidad Attestto
      </p>
      <div class="flex gap-2">
        <div class="flex flex-1 items-center rounded-md border border-[#2c3a4f] bg-[#0d1520] px-2">
          <span class="text-sm text-[#5f6d80]">@</span>
          <input
            v-model="aliasInput"
            type="text"
            autocapitalize="none"
            spellcheck="false"
            placeholder="tu-usuario"
            class="w-full bg-transparent px-2 py-2 text-sm text-white placeholder:text-[#5f6d80] focus:outline-none"
            @keyup.enter="onAdd"
          />
        </div>
        <button
          class="flex items-center gap-1 rounded-md bg-[#3b6fd4] px-4 py-2 text-sm font-medium text-white hover:bg-[#4a8ec8]"
          @click="onAdd"
        >
          <PlusIcon class="h-4 w-4" /> Agregar
        </button>
      </div>
      <p v-if="addError" class="mt-2 text-xs text-amber-400">{{ addError }}</p>
    </div>

    <!-- Existing identities -->
    <div>
      <p class="mb-2 text-xs font-medium uppercase tracking-wider text-[#8a97a8]">Mis identidades</p>
      <div class="space-y-2">
        <div
          v-for="acct in demoAccounts"
          :key="acct.did"
          class="flex items-center gap-3 rounded-lg border border-[#243044] bg-[#111a28] p-3"
        >
          <FingerPrintIcon class="h-6 w-6 text-[#6fa8dc]" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ acct.label }}</p>
            <p class="font-mono text-xs text-[#8a97a8]">{{ formatIban(acct.iban) }}</p>
          </div>
          <p class="font-mono text-[10px] text-[#5f6d80]">{{ acct.did }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
