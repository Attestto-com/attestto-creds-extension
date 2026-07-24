/**
 * DEMO ONLY — mock account data for the Attestto Pay walkthrough.
 *
 * The user never sees a Solana address or a Circle wallet public key: the
 * account surface is a familiar IBAN. Solana + the Circle custodial wallet are
 * internal plumbing, resolved backend-side after the DID signs the intent.
 *
 * Every value here is fabricated for the demo — no real IBAN, no real balance,
 * no real key. `addByAlias` simulates "add one of your Attestto IDs by
 * username" (e.g. "chongkan"): the alias becomes a did:sns and gets a mock IBAN.
 * Users cannot edit the IBAN or add a raw account number — only a DID alias.
 */
import { reactive } from 'vue'

export interface DemoAccount {
  /** Attestto username / alias the user typed, e.g. "chongkan". */
  alias: string
  /** did:sns derived from the alias — the identity that signs. */
  did: string
  /** Friendly identity label shown on the card. */
  label: string
  /** Familiar account identifier the user sees. NO Solana / Circle address. */
  iban: string
}

/**
 * NOTE: there is deliberately NO balance field. The browser never queries the
 * chain or the server for a balance — that would require broadcasting the
 * wallet's public key/address, and the public key never travels from the
 * browser. Payments follow the card model: no client-side pre-check, the
 * backend accepts or rejects at settlement time.
 */

/** CR IBAN convention: "CR" + 2 check + 18 digits. Fabricated for the demo. */
function mockIbanForAlias(alias: string): string {
  // Deterministic-but-fake: derive 20 digits from the alias characters so the
  // same alias always renders the same IBAN within a demo session.
  let seed = 0
  for (const ch of alias) seed = (seed * 31 + ch.charCodeAt(0)) % 1_000_000_007
  const digits = String(seed).padStart(9, '0').repeat(3).slice(0, 20)
  return `CR${digits}`
}

/** Group an IBAN into 4-char blocks for display: CR05 0152 0200 … */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim()
}

/** Build a demo account from a bare alias. */
export function accountFromAlias(alias: string): DemoAccount {
  const clean = alias.trim().replace(/\s+/g, '').toLowerCase()
  return {
    alias: clean,
    did: `did:sns:${clean}.attestto.sol`,
    label: clean,
    iban: mockIbanForAlias(clean),
  }
}

/** Session-lived demo account list (resets when the popup closes). */
export const demoAccounts = reactive<DemoAccount[]>([accountFromAlias('chongkan')])

/** Add an Attestto ID by alias; no-op if the alias is already present. */
export function addByAlias(alias: string): DemoAccount | null {
  const acct = accountFromAlias(alias)
  if (!acct.alias) return null
  if (demoAccounts.some((a) => a.alias === acct.alias)) return null
  demoAccounts.push(acct)
  return acct
}
