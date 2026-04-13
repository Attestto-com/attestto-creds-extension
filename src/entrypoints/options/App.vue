<script setup lang="ts">
</script>

<template>
  <div style="max-width: 42rem; margin: 0 auto; padding: 2rem">
    <h1 style="margin-bottom: 1.5rem; font-size: var(--ext-text-xl); font-weight: 700; color: var(--ext-text-primary)">Attestto Vault — Settings</h1>

    <section class="ext-card" style="margin-bottom: 2rem; padding: 1.5rem">
      <h2 style="margin-bottom: 0.5rem; font-size: var(--ext-text-lg); font-weight: 600; color: var(--ext-text-primary)">Identity</h2>
      <p style="font-size: var(--ext-text-md); color: var(--ext-text-secondary)">
        Self-sovereign identity wallet with verifiable credentials,
        selective disclosure (SD-JWT + JSON-LD), and DIDComm v2 proof exchange.
      </p>
    </section>

    <section class="ext-card" style="padding: 1.5rem">
      <h2 style="margin-bottom: 0.5rem; font-size: var(--ext-text-lg); font-weight: 600; color: var(--ext-text-primary)">Wallet</h2>
      <p style="font-size: var(--ext-text-md); color: var(--ext-text-secondary)">
        Your DID keys are stored locally with AES-256-GCM encryption.
        The decryption key lives in session storage and is cleared when the browser closes.
      </p>
    </section>
  </div>
</template>
