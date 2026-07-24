/**
 * DEMO ONLY — mock Attestto Pay client.
 *
 * Real flow (production): the DID signs a PayIntent → the signature goes to the
 * backend → the backend settles via a Circle custodial wallet on Solana → a
 * confirmation returns. The user never touches the custodial wallet; they only
 * sign with their DID and see a familiar IBAN.
 *
 * This mock keeps the exact shape of that flow but returns a simulated
 * settlement so the walkthrough runs with no backend, no Circle credentials,
 * and no real funds. Swap `submitPayIntent` for a real backend-client call to
 * go live (Circle sandbox first).
 */

/** A payable government procedure (trámite). Amounts are CRC colones. */
export interface Tramite {
  id: string
  title: string
  /** The payee institution (merchant). */
  authority: string
  /** 'state' renders the verified government badge; 'private' does not. */
  authorityKind: 'state' | 'private'
  /** The payee's resolvable DID — proof the merchant is who it claims to be. */
  authorityDid: string
  /** Cédula jurídica of the institution, for the receipt. */
  authorityCedula: string
  /** Line items that sum to `total` — includes fiscal stamps (timbres). */
  lines: { label: string; amountCRC: number }[]
  total: number
}

/** Nicoya municipal certificate — the ₡530 procedure we designed. */
export const NICOYA_CONSTANCIA: Tramite = {
  id: 'nicoya-constancia',
  title: 'Constancia Municipal',
  authority: 'Municipalidad de Nicoya',
  authorityKind: 'state',
  authorityDid: 'did:sns:nicoya.muni.attestto.sol',
  authorityCedula: '3-014-042127',
  lines: [
    { label: 'Constancia / certificación', amountCRC: 500 },
    { label: 'Timbre fiscal (Tesorería Nacional)', amountCRC: 25 },
    { label: 'Timbre de archivo (Archivo Nacional, Ley 7202)', amountCRC: 5 },
  ],
  total: 530,
}

export interface PayIntent {
  tramiteId: string
  amountCRC: number
  /** The DID that signs the intent (the payer identity). */
  signerDid: string
  /** The account the user sees paying (IBAN) — display only. */
  iban: string
}

export interface PaySettlement {
  status: 'settled'
  /** Human-facing payment reference shown on the receipt. */
  reference: string
  /** ISO-ish timestamp string for the receipt (demo, static-safe). */
  paidAt: string
}

/** Simulate the DID signature the extension would produce for this intent. */
export async function signPayIntent(intent: PayIntent): Promise<string> {
  await delay(700)
  // A real signature would come from the vault signer; this is a demo stand-in.
  const payload = `${intent.tramiteId}:${intent.amountCRC}:${intent.signerDid}`
  return `demo-sig:${btoa(payload).slice(0, 24)}`
}

/**
 * Mock backend settlement. In production this POSTs the signed intent to the
 * backend, which settles via Circle on Solana. Here it just waits and returns a
 * fabricated reference.
 */
export async function submitPayIntent(
  _intent: PayIntent,
  _signature: string,
  now: () => number = () => 0,
): Promise<PaySettlement> {
  await delay(900)
  const ref = `ATT-${String(Math.abs(hash(_signature)) % 1_000_000).padStart(6, '0')}`
  return { status: 'settled', reference: ref, paidAt: isoFrom(now()) }
}

/** Format CRC colones for display: 530 -> "₡530", 48500 -> "₡48.500". */
export function formatCRC(amount: number): string {
  return `₡${amount.toLocaleString('es-CR')}`
}

/** Currencies the user can pick. Internally settled as USDC; user sees these. */
export type PayCurrency = 'CRC' | 'USD'

export const CURRENCIES: { code: PayCurrency; symbol: string; label: string }[] = [
  { code: 'CRC', symbol: '₡', label: 'Colones' },
  { code: 'USD', symbol: '$', label: 'Dólares' },
]

/** Format an amount in the chosen currency: (530,'CRC') -> "₡530". */
export function formatMoney(amount: number, currency: PayCurrency): string {
  const c = CURRENCIES.find((x) => x.code === currency) ?? CURRENCIES[0]
  return `${c.symbol}${amount.toLocaleString('es-CR')}`
}

/**
 * DEMO — a peer Pay or Request, delivered as a DID message.
 *
 * Both "Pay" and "Request" are the same primitive: a signed envelope addressed
 * to the recipient's DID (derived from their Attestto alias), delivered by the
 * relay to their Inbox. "Pay" carries a signed PayIntent; "Request" carries a
 * payment request the recipient can approve. Mocked here — no relay, no funds.
 */
export interface PeerMessageResult {
  status: 'sent'
  kind: 'pay' | 'request'
  toDid: string
  reference: string
}

export async function sendPeerMessage(
  kind: 'pay' | 'request',
  toAlias: string,
  amount: number,
  currency: PayCurrency,
  fromDid: string,
): Promise<PeerMessageResult> {
  const toDid = `did:sns:${toAlias.trim().replace(/\s+/g, '').toLowerCase()}.attestto.sol`
  await delay(700) // sign with DID
  await delay(700) // relay delivery
  const seed = `${kind}:${toDid}:${amount}:${currency}:${fromDid}`
  const reference = `ATT-${String(Math.abs(hash(seed)) % 1_000_000).padStart(6, '0')}`
  return { status: 'sent', kind, toDid, reference }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

/** Demo timestamp; caller passes a millis source (0 = unknown, safe default). */
function isoFrom(ms: number): string {
  if (!ms) return 'ahora'
  return new Date(ms).toLocaleString('es-CR')
}
