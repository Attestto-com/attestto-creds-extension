import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { readVault, writeVault } from '@/utils/vault'
import { useWalletStore } from '@/stores/wallet'
import type { StoredCredential } from '@/types/credential'

export const useCredentialsStore = defineStore('credentials', () => {
  const _credentials = ref<StoredCredential[]>([])
  const walletStore = useWalletStore()

  const credentials = computed(() => _credentials.value)

  /**
   * Load credentials from the encrypted vault after wallet unlock.
   */
  async function loadFromVault(): Promise<void> {
    const vault = await readVault()
    _credentials.value = vault?.credentials ?? []
  }

  /**
   * Persist current credentials array back to the vault.
   */
  async function _persist(): Promise<void> {
    const vault = await readVault()
    if (!vault) return
    vault.credentials = _credentials.value
    await writeVault(vault)
  }

  /**
   * Add a credential and persist to vault.
   */
  async function addCredential(cred: StoredCredential): Promise<void> {
    _credentials.value = [..._credentials.value, cred]
    await _persist()
  }

  /**
   * Remove a credential by ID and persist.
   */
  async function removeCredential(id: string): Promise<void> {
    _credentials.value = _credentials.value.filter((c) => c.id !== id)
    await _persist()
  }

  /**
   * Get a single credential by ID.
   */
  function getById(id: string): StoredCredential | undefined {
    return _credentials.value.find((c) => c.id === id)
  }

  /**
   * Clear in-memory state on wallet lock.
   */
  function clearOnLock(): void {
    _credentials.value = []
  }

  // Auto-load/clear when wallet lock state changes
  watch(
    () => walletStore.isUnlocked,
    async (unlocked) => {
      if (unlocked) {
        await loadFromVault()
      } else {
        clearOnLock()
      }
    },
  )

  return {
    credentials,
    loadFromVault,
    addCredential,
    removeCredential,
    getById,
    clearOnLock,
  }
})
