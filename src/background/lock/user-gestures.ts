/**
 * Story 1.14 — which messages count as "the user did something".
 *
 * This list is the whole difference between an idle lock and an auto-extend. The
 * old timer restarted on ANY service-worker wake, so a background tab calling
 * `navigator.credentials` held the vault open; here, a message only counts if a
 * human demonstrably acted.
 *
 * Membership rule — a type belongs here only if it cannot be produced without a
 * click:
 *
 *   - `*_APPROVE` / `*_DENY` are sent by the approval window in response to the
 *     user pressing a button. There is no other way to emit them.
 *   - `WALLET_ACTIVITY` is the popup and options page reporting interaction.
 *
 * Deliberately absent:
 *
 *   - `*_GET_PENDING` — the approval page fetching its own row on load. The
 *     window was opened by a PAGE request, so treating its load as user activity
 *     would let a site re-arm the timer by asking for a signature the user never
 *     answers.
 *   - every request type (`AUTH_REQUEST`, `CREDENTIAL_OFFER`, `PAYMENT_REQUEST`,
 *     `SIGN_*_REQUEST`, `DID_SYNC`, `DIDCOMM_INBOUND`, …) — all page- or
 *     network-originated. These are precisely what used to extend the lock.
 *   - `SESSION_EXPIRED` — that is a lock, not activity.
 *
 * Typed as `MessageType` so a renamed message is a compile error rather than a
 * silently-never-matching string.
 */
import type { MessageType } from '@/background/router/message-types'
import { isExtensionSender } from '@/utils/message-guard'

const USER_GESTURE_LIST = [
  'WALLET_ACTIVITY',
  'CREDENTIAL_OFFER_APPROVE',
  'CREDENTIAL_OFFER_DENY',
  'SIGN_DOCUMENT_APPROVE',
  'SIGN_DOCUMENT_DENY',
  'AUTH_APPROVE',
  'AUTH_DENY',
  'SIGN_ATTESTTO_PDF_APPROVE',
  'SIGN_ATTESTTO_PDF_DENY',
  'PAYMENT_APPROVE',
  'PAYMENT_DENY',
  'CHAPI_APPROVE',
  'CHAPI_DENY',
] as const satisfies readonly MessageType[]

export const USER_GESTURE_MESSAGES: ReadonlySet<MessageType> = new Set(USER_GESTURE_LIST)

export function isUserGesture(type: unknown): type is MessageType {
  return typeof type === 'string' && USER_GESTURE_MESSAGES.has(type as MessageType)
}

/**
 * The whole activity decision, in one place the entrypoint can only call.
 *
 * BOTH halves are load-bearing. The type check alone is not enough: a content
 * script runs on every https origin and can post `{type:'AUTH_APPROVE'}` at
 * the worker, so without the sender check any page could hold the vault open — the
 * same defect in a new costume. The sender check alone is not enough either: the
 * extension's own surfaces send plenty of messages that are not gestures.
 */
export function shouldCountAsActivity(
  sender: chrome.runtime.MessageSender | undefined,
  message: unknown,
): boolean {
  const type = (message as { type?: unknown } | null | undefined)?.type
  return isExtensionSender(sender) && isUserGesture(type)
}
