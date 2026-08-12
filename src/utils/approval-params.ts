/**
 * The approval-window URL contract — ONE home (Story 1.13 Phase 4).
 *
 * `approval.html` is opened by the background with a query string, and the
 * approval page decides which consent UI to render by reading that query string.
 * Those two halves are a contract with no compiler between them: rename a param
 * on the background side and the page silently falls through to "No request ID".
 *
 * `resolveApprovalMode` is that decision, extracted so the SHIPPED parser is a
 * thing a test can call. `approval/App.vue` consumes it, and
 * `background/consent/approval-window.spec.ts` feeds it the URLs the openers
 * actually produce — so the opener specs assert against the real reader rather
 * than restating the openers' own literals (the same single-home discipline
 * Story 1.12 applied to gov-TLD classification).
 *
 * The if/else PRIORITY ORDER below is load-bearing and preserved verbatim from
 * the page: a URL carrying two mode params resolves to the earlier one.
 */

export type ApprovalMode =
  | { mode: 'credentialOffer'; requestId: string; format: string; issuerName: string; origin: string }
  | { mode: 'auth'; requestId: string; origin: string; siteName: string | null }
  | { mode: 'attesttoPdf'; requestId: string; origin: string; fileName: string; documentHash: string }
  | { mode: 'signing'; requestId: string; origin: string; documentTitle: string; signerName: string }
  | { mode: 'payment'; requestId: string; origin: string; amount: number; currency: string; merchant: string }
  | { mode: 'chapi'; requestId: string; origin: string }
  | { mode: 'none' }

/** The query-string key that selects each mode. Exported so openers name it once. */
export const APPROVAL_MODE_PARAM = {
  credentialOffer: 'credentialOfferId',
  auth: 'authRequest',
  attesttoPdf: 'attesttoPdfRequest',
  signing: 'signingRequest',
  payment: 'paymentRequest',
  chapi: 'chapiRequest',
} as const

/**
 * Resolve which consent UI a `approval.html?…` query string asks for.
 *
 * @param search - `window.location.search` (leading `?` optional).
 */
export function resolveApprovalMode(search: string): ApprovalMode {
  const params = new URLSearchParams(search)
  const origin = params.get('origin') || ''

  const credentialOfferId = params.get(APPROVAL_MODE_PARAM.credentialOffer)
  if (credentialOfferId) {
    return {
      mode: 'credentialOffer',
      requestId: credentialOfferId,
      format: params.get('format') || '',
      issuerName: params.get('issuerName') || 'A site',
      origin,
    }
  }

  const authRequest = params.get(APPROVAL_MODE_PARAM.auth)
  if (authRequest) {
    return {
      mode: 'auth',
      requestId: authRequest,
      origin,
      siteName: params.get('siteName')?.trim() || null,
    }
  }

  const attesttoPdfRequest = params.get(APPROVAL_MODE_PARAM.attesttoPdf)
  if (attesttoPdfRequest) {
    return {
      mode: 'attesttoPdf',
      requestId: attesttoPdfRequest,
      origin,
      fileName: params.get('fileName') || 'document.pdf',
      documentHash: params.get('documentHash') || '',
    }
  }

  const signingRequest = params.get(APPROVAL_MODE_PARAM.signing)
  if (signingRequest) {
    return {
      mode: 'signing',
      requestId: signingRequest,
      origin,
      documentTitle: params.get('documentTitle') || '',
      signerName: params.get('signerName') || '',
    }
  }

  const paymentRequest = params.get(APPROVAL_MODE_PARAM.payment)
  if (paymentRequest) {
    return {
      mode: 'payment',
      requestId: paymentRequest,
      origin,
      amount: Number(params.get('amount') || '0'),
      currency: params.get('currency') || 'USDC',
      merchant: params.get('merchant') || '',
    }
  }

  const chapiRequest = params.get(APPROVAL_MODE_PARAM.chapi)
  if (chapiRequest) {
    return { mode: 'chapi', requestId: chapiRequest, origin }
  }

  return { mode: 'none' }
}

/**
 * The WRITE half of the contract, deliberately in the same file as the read half.
 *
 * Each builder produces the query params for one consent flow. Keeping them here
 * means a param rename cannot half-apply: the reader above and the writers below
 * cite `APPROVAL_MODE_PARAM` and the same field names, in one place, and
 * `approval-params.spec.ts` round-trips every builder through `resolveApprovalMode`.
 *
 * Empty strings are passed through rather than dropped — the resolver defaults
 * them, and the pre-extraction openers sent them too. `siteName` is the one
 * exception: the auth opener omits it entirely when unknown, matching the page's
 * `siteName ?? null` empty-state.
 */
export const approvalParams = {
  credentialOffer(req: { id: string; format: string; issuerName: string; origin: string | null }): Record<string, string> {
    return {
      [APPROVAL_MODE_PARAM.credentialOffer]: req.id,
      format: req.format,
      issuerName: req.issuerName,
      origin: req.origin ?? '',
    }
  },

  auth(req: { id: string; origin: string; siteName?: string }): Record<string, string> {
    const params: Record<string, string> = {
      [APPROVAL_MODE_PARAM.auth]: req.id,
      origin: req.origin || '',
    }
    if (req.siteName) params.siteName = req.siteName
    return params
  },

  attesttoPdf(req: { id: string; origin?: string; fileName?: string; documentHash?: string }): Record<string, string> {
    return {
      [APPROVAL_MODE_PARAM.attesttoPdf]: req.id,
      origin: req.origin || '',
      fileName: req.fileName || '',
      documentHash: req.documentHash || '',
    }
  },

  signing(req: { id: string; origin?: string; documentTitle?: string; signerName?: string }): Record<string, string> {
    return {
      [APPROVAL_MODE_PARAM.signing]: req.id,
      origin: req.origin || '',
      documentTitle: req.documentTitle || '',
      signerName: req.signerName || '',
    }
  },

  payment(req: { id: string; origin?: string; amount: number; currency?: string; merchantName?: string }): Record<string, string> {
    return {
      [APPROVAL_MODE_PARAM.payment]: req.id,
      origin: req.origin || '',
      amount: String(req.amount),
      currency: req.currency || 'USDC',
      merchant: req.merchantName || '',
    }
  },

  chapi(req: { id: string; origin?: string }): Record<string, string> {
    return {
      [APPROVAL_MODE_PARAM.chapi]: req.id,
      origin: req.origin || '',
    }
  },
}
