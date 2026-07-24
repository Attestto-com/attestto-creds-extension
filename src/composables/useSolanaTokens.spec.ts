import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { useSolanaTokens } from './useSolanaTokens'

// The composable now calls the Solana JSON-RPC (getTokenAccountsByOwner) over
// `fetch` instead of bundling @solana/web3.js. Mock fetch accordingly.
function rpcOk(value: unknown[]) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { value } }) }
}

function makeTokenAccount(mint: string, amount: string, decimals: number, uiAmount: number) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: { amount, decimals, uiAmount },
          },
        },
      },
    },
  }
}

let fetchMock: ReturnType<typeof vi.fn>

describe('useSolanaTokens', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(rpcOk([]))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('returns empty array when no wallet address provided', () => {
    const addr = ref<string | null>(null)
    const { tokens, loading, error } = useSolanaTokens(addr)

    expect(tokens.value).toEqual([])
    expect(loading.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('parses SPL token accounts correctly', async () => {
    const splAccounts = [
      makeTokenAccount('So11111111111111111111111111111111111111112', '1000000', 6, 1.0),
    ]

    const addr = ref<string | null>(null)
    const { tokens, refresh } = useSolanaTokens(addr)

    // refresh() fetches SPL then Token-2022 (in Promise.all order).
    fetchMock.mockResolvedValueOnce(rpcOk(splAccounts)).mockResolvedValueOnce(rpcOk([]))

    addr.value = '9WzDXwBbmPEfPafWLKkAGAtpjFCi2FMvRBWqWPWCzTfN'
    await nextTick()
    await vi.waitFor(() => expect(tokens.value.length).toBeGreaterThan(0))

    expect(tokens.value).toHaveLength(1)
    expect(tokens.value[0].mint).toBe('So11111111111111111111111111111111111111112')
    expect(tokens.value[0].balance).toBe(1.0)
    expect(tokens.value[0].decimals).toBe(6)
    expect(tokens.value[0].isToken2022).toBe(false)
    expect(tokens.value[0].rawBalance).toBe('1000000')
    void refresh
  })

  it('parses Token-2022 accounts with isToken2022 true', async () => {
    const t22Accounts = [
      makeTokenAccount('AT2PmPv9tJkKyR9u1nQ2YvXXEeMrLCQUhtDeiKSwxgkp', '1', 0, 1),
    ]

    const addr = ref<string | null>(null)
    const { tokens } = useSolanaTokens(addr)

    fetchMock.mockResolvedValueOnce(rpcOk([])).mockResolvedValueOnce(rpcOk(t22Accounts))

    addr.value = '9WzDXwBbmPEfPafWLKkAGAtpjFCi2FMvRBWqWPWCzTfN'
    await nextTick()
    await vi.waitFor(() => expect(tokens.value.length).toBeGreaterThan(0))

    expect(tokens.value).toHaveLength(1)
    expect(tokens.value[0].isToken2022).toBe(true)
    expect(tokens.value[0].mint).toBe('AT2PmPv9tJkKyR9u1nQ2YvXXEeMrLCQUhtDeiKSwxgkp')
  })

  it('handles RPC errors gracefully', async () => {
    const addr = ref<string | null>(null)
    const { tokens, error } = useSolanaTokens(addr)

    fetchMock.mockRejectedValue(new Error('Network error'))

    addr.value = '9WzDXwBbmPEfPafWLKkAGAtpjFCi2FMvRBWqWPWCzTfN'
    await nextTick()
    await vi.waitFor(() => expect(error.value).not.toBeNull())

    expect(error.value).toBe('Network error')
    expect(tokens.value).toEqual([])
  })

  it('clears tokens when wallet address changes to null', async () => {
    const splAccounts = [
      makeTokenAccount('TestMint111111111111111111111111111111111111', '500', 2, 5.0),
    ]

    const addr = ref<string | null>(null)
    const { tokens } = useSolanaTokens(addr)

    fetchMock.mockResolvedValueOnce(rpcOk(splAccounts)).mockResolvedValueOnce(rpcOk([]))

    addr.value = '9WzDXwBbmPEfPafWLKkAGAtpjFCi2FMvRBWqWPWCzTfN'
    await nextTick()
    await vi.waitFor(() => expect(tokens.value.length).toBeGreaterThan(0))

    addr.value = null
    await nextTick()

    expect(tokens.value).toEqual([])
  })
})
