import { ref, watch, type Ref } from 'vue'

/**
 * Reactive wrapper around chrome.storage.local.
 *
 * Works like `ref()` but persists to extension storage automatically.
 * Listens for external changes (e.g. from another extension page or
 * the background service worker) and keeps the ref in sync.
 */
export function useExtensionStorage<T>(
  key: string,
  defaultValue: T,
): Ref<T> {
  const data = ref<T>(defaultValue) as Ref<T>

  // Load initial value
  chrome.storage.local.get(key, (result) => {
    if (result[key] !== undefined) {
      data.value = result[key] as T
    }
  })

  // Persist on change
  watch(
    data,
    (newVal) => {
      chrome.storage.local.set({ [key]: newVal })
    },
    { deep: true },
  )

  // Sync from external changes (other pages, background)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[key]) {
      data.value = (changes[key].newValue as T) ?? defaultValue
    }
  })

  return data
}
