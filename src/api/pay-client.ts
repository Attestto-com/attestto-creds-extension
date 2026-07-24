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
  authority: string
  /** Line items that sum to `total` — includes fiscal stamps (timbres). */
  lines: { label: string; amountCRC: number }[]
  total: number
}

/** Nicoya municipal certificate — the ₡530 procedure we designed. */
export const NICOYA_CONSTANCIA: Tramite = {
  id: 'nicoya-constancia',
  title: 'Constancia Municipal',
  authority: 'Municipalidad de Nicoya',
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
