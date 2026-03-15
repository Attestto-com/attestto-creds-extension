import { ref, watch, type Ref } from 'vue'
import { Connection, PublicKey } from '@solana/web3.js'
import type { LinkedToken } from '@/types/solana'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com'

export function useSolanaTokens(walletAddress: Ref<string | null>) {
  const tokens = ref<LinkedToken[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchTokens(programId: PublicKey, isToken2022: boolean): Promise<LinkedToken[]> {
    const address = walletAddress.value
    if (!address) return []

    const connection = new Connection(RPC_URL)
    const pubkey = new PublicKey(address)
    const response = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId,
    })

    return response.value.map((account) => {
      const parsed = account.account.data.parsed
      const info = parsed.info
      const tokenAmount = info.tokenAmount

      return {
        mint: info.mint as string,
        symbol: 'Unknown',
        name: `${(info.mint as string).slice(0, 4)}...${(info.mint as string).slice(-4)}`,
        balance: tokenAmount.uiAmount ?? 0,
        rawBalance: tokenAmount.amount as string,
        decimals: tokenAmount.decimals as number,
        tokenProgram: programId.toBase58(),
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
