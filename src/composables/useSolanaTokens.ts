import { ref, watch, type Ref } from 'vue'
import type { LinkedToken } from '@/types/solana'

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'

/** Shape of a jsonParsed SPL token account returned by getTokenAccountsByOwner. */
interface ParsedTokenAccount {
  account: {
    data: {
      parsed: {
        info: {
          mint: string
          tokenAmount: { uiAmount: number | null; amount: string; decimals: number }
        }
      }
    }
  }
}

/**
 * Minimal read-only Solana JSON-RPC call. `Connection` from @solana/web3.js is
 * just a wrapper over this HTTP POST; calling the RPC directly lets us drop that
 * heavy dependency (and its vulnerable jayson/uuid subtree) from the shipped
 * bundle (SOC-13).
 */
async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`Solana RPC ${method} failed: HTTP ${res.status}`)
  const json = (await res.json()) as { result?: T; error?: { message?: string } }
  if (json.error) throw new Error(`Solana RPC ${method} error: ${json.error.message ?? 'unknown'}`)
  return json.result as T
}

export function useSolanaTokens(walletAddress: Ref<string | null>) {
  const tokens = ref<LinkedToken[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchTokens(programId: string, isToken2022: boolean): Promise<LinkedToken[]> {
    const address = walletAddress.value
    if (!address) return []

    const result = await solanaRpc<{ value: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
      address,
      { programId },
      { encoding: 'jsonParsed' },
    ])

    return result.value.map((account) => {
      const info = account.account.data.parsed.info
      const tokenAmount = info.tokenAmount

      return {
        mint: info.mint,
        symbol: 'Unknown',
        name: `${info.mint.slice(0, 4)}...${info.mint.slice(-4)}`,
        balance: tokenAmount.uiAmount ?? 0,
        rawBalance: tokenAmount.amount,
        decimals: tokenAmount.decimals,
        tokenProgram: programId,
        isToken2022,
      }
    })
  }

  async function refresh(): Promise<void> {
    if (!walletAddress.value) {
      tokens.value = []
      return
    }

    loading.value = true
    error.value = null

    try {
      const [splTokens, token2022Tokens] = await Promise.all([
        fetchTokens(TOKEN_PROGRAM_ID, false),
        fetchTokens(TOKEN_2022_PROGRAM_ID, true),
      ])
      tokens.value = [...splTokens, ...token2022Tokens]
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch tokens'
      tokens.value = []
    } finally {
      loading.value = false
    }
  }

  watch(walletAddress, (newAddr) => {
    if (newAddr) {
      refresh()
    } else {
      tokens.value = []
      error.value = null
    }
  })

  return { tokens, loading, error, refresh }
}
