<script setup lang="ts">
</script>

<template>
  <div class="mx-auto max-w-2xl p-8">
    <h1 class="mb-6 text-2xl font-bold">Attestto ID — Settings</h1>

    <section class="mb-8 rounded-lg border border-slate-700 bg-slate-900 p-6">
      <h2 class="mb-2 text-lg font-semibold">Identity</h2>
      <p class="text-sm text-slate-400">
        Self-sovereign identity wallet with verifiable credentials,
        selective disclosure (SD-JWT + JSON-LD), and DIDComm v2 proof exchange.
      </p>
    </section>

    <section class="rounded-lg border border-slate-700 bg-slate-900 p-6">
      <h2 class="mb-2 text-lg font-semibold">Wallet</h2>
      <p class="text-sm text-slate-400">
        Your DID keys are stored locally with AES-256-GCM encryption.
        The decryption key lives in session storage and is cleared when the browser closes.
      </p>
    </section>
  </div>
</template>
