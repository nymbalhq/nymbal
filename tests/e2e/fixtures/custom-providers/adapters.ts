import { randomUUID } from 'node:crypto'

// P2-05 decision 9: the swap fixture's own adapters, injected through the config's `adapters` export into the
// `custom` search and payments slots. Self-contained on purpose: nothing from @nymbalhq/platform (jiti would load a
// second instance of it, and of its error classes) and no runtime import from @nymbalhq/types. The shapes below are
// the SearchAdapter and PaymentsAdapter contracts written out; tests/contracts/custom-providers.test.ts runs both
// adapter contracts on them, which is where a drift from @nymbalhq/types shows.
//
// - search: in memory, `index` and `search` only (no `facet`), a case-insensitive substring match on the name;
// - payments: the native stub's `+stub-*` receipt-email rules, with `client()` null, so the storefront has no payment
//   step to render.

export type Health = { status: 'healthy' | 'degraded' | 'down'; detail?: string }

export interface Doc {
  id: string
  type: string
  fields: Record<string, unknown>
}

/** What the fixture's search offers: no `facet`, so the listing route sends no facets and no filter renders. */
export const FIXTURE_SEARCH_CAPABILITIES: readonly string[] = ['index', 'search']

export function createFixtureSearchAdapter() {
  const docs = new Map<string, Doc>()
  const nameOf = (doc: Doc) => {
    const name = doc.fields['name']
    return typeof name === 'string' ? name.toLowerCase() : ''
  }
  return {
    kind: 'search' as const,
    providerName: 'p2-05-fixture-search',
    capabilities: (): readonly string[] => [...FIXTURE_SEARCH_CAPABILITIES],
    producesEvents: [] as readonly string[],
    consumesEvents: [] as readonly string[],
    initialize: async (_config: unknown): Promise<void> => undefined,
    healthCheck: async (): Promise<Health> => ({ status: 'healthy' }),

    async index(documents: Doc[]): Promise<{ indexed: number }> {
      for (const doc of documents) docs.set(doc.id, { ...doc, fields: { ...doc.fields } })
      return { indexed: documents.length }
    },

    async remove(documentIds: string[]): Promise<void> {
      for (const id of documentIds) docs.delete(id)
    },

    async search(
      query: string,
      params?: { limit?: number; cursor?: string; filters?: Record<string, unknown> },
    ): Promise<{ items: Doc[]; total: number; nextCursor: string | null }> {
      const q = query.trim().toLowerCase()
      const hits = [...docs.values()].filter((doc) => q === '' || nameOf(doc).includes(q))
      const limit = params?.limit ?? 20
      return { items: hits.slice(0, limit), total: hits.length, nextCursor: null }
    },

    // Not offered (no `facet` capability); the method exists because the interface has it, and answers no values.
    async facet(
      field: string,
    ): Promise<{ field: string; label: string; values: Array<{ value: string }> }> {
      return { field, label: field, values: [] }
    },
  }
}

export type PaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'cancelled'
  | 'failed'

export interface Intent {
  id: string
  amountMinor: number
  currency: string
  status: PaymentStatus
  refundedMinor: number
}

/** The kernel matches a payment failure by its code (`payment.<reason>`), as PaymentError carries it. */
class FixturePaymentError extends Error {
  readonly code: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'PaymentError'
    this.code = `payment.${reason}`
  }
}

const ID_PREFIX = 'pi_fixture_'

/** The stub's rule: the receipt email's local part ending `+stub-pending` waits, `+stub-decline` fails. */
function statusFor(receiptEmail: string | undefined): PaymentStatus {
  const address = receiptEmail ?? ''
  const at = address.lastIndexOf('@')
  const local = at < 0 ? address : address.slice(0, at)
  if (local.endsWith('+stub-pending')) return 'requires_action'
  if (local.endsWith('+stub-decline')) return 'failed'
  return 'succeeded'
}

export function createFixturePaymentsAdapter() {
  const intents = new Map<string, Intent>()
  const toIntent = (i: Intent) => ({
    id: i.id,
    clientSecret: `${i.id}_secret`,
    amountMinor: i.amountMinor,
    currency: i.currency,
    status: i.status,
  })
  return {
    kind: 'payments' as const,
    providerName: 'p2-05-fixture-payments',
    capabilities: (): readonly string[] => ['intent', 'capture', 'refund'],
    /** No client half: the storefront renders no payment step. */
    client: (): null => null,
    producesEvents: ['payment.captured.v1', 'payment.failed.v1', 'payment.refunded.v1'] as const,
    consumesEvents: [] as readonly string[],
    initialize: async (_config: unknown): Promise<void> => undefined,
    healthCheck: async (): Promise<Health> => ({ status: 'healthy' }),

    async createPaymentIntent(params: {
      amountMinor: number
      currency: string
      receiptEmail?: string
    }) {
      const intent: Intent = {
        id: `${ID_PREFIX}${randomUUID()}`,
        amountMinor: params.amountMinor,
        currency: params.currency,
        status: statusFor(params.receiptEmail),
        refundedMinor: 0,
      }
      intents.set(intent.id, intent)
      return toIntent(intent)
    },

    async capturePayment(intentId: string, _amountMinor?: number) {
      const intent = intents.get(intentId)
      if (!intent) throw new FixturePaymentError('capture_failed', `unknown intent ${intentId}`)
      intent.status = 'succeeded'
      return {
        paymentId: intent.id,
        capturedAmountMinor: intent.amountMinor,
        currency: intent.currency,
        status: 'succeeded' as const,
      }
    },

    async refund(
      paymentId: string,
      amountMinor?: number,
      reason?: string,
      opts?: { idempotencyKey?: string; currency?: string },
    ) {
      const answer = (amount: number, currency: string) => ({
        refundId: `re_fixture_${randomUUID()}`,
        paymentId,
        amountMinor: amount,
        currency,
        reason: reason ?? null,
        status: 'succeeded' as const,
      })
      if (!paymentId.startsWith(ID_PREFIX)) {
        throw new FixturePaymentError('refund_rejected', `${paymentId} is not a fixture intent`)
      }
      const intent = intents.get(paymentId)
      if (!intent) {
        if (amountMinor === undefined || amountMinor <= 0 || opts?.currency === undefined) {
          throw new FixturePaymentError('refund_rejected', `intent ${paymentId} is no longer held`)
        }
        return answer(amountMinor, opts.currency)
      }
      if (intent.status !== 'succeeded') {
        throw new FixturePaymentError('refund_rejected', `intent ${paymentId} was never captured`)
      }
      const left = intent.amountMinor - intent.refundedMinor
      const amount = amountMinor ?? left
      if (amount <= 0 || amount > left) {
        throw new FixturePaymentError('refund_rejected', `refund of ${amount} exceeds ${left}`)
      }
      intent.refundedMinor += amount
      return answer(amount, intent.currency)
    },

    async getPaymentStatus(intentId: string): Promise<PaymentStatus> {
      return intents.get(intentId)?.status ?? 'failed'
    },

    async getPaymentIntent(intentId: string) {
      const intent = intents.get(intentId)
      if (!intent) throw new FixturePaymentError('intent_failed', `unknown intent ${intentId}`)
      return toIntent(intent)
    },

    async cancelPaymentIntent(intentId: string): Promise<void> {
      const intent = intents.get(intentId)
      if (!intent) return
      if (intent.status === 'succeeded') {
        throw new FixturePaymentError('cancel_refused', `intent ${intentId} is already captured`)
      }
      intent.status = 'cancelled'
    },

    async parseWebhook(rawBody: Buffer | string, _signature: string) {
      let event: {
        id?: string
        kind?: 'payment.captured' | 'payment.failed' | 'payment.refunded' | 'ignored'
        paymentIntentId?: string
        amountMinor?: number
        currency?: string
      }
      try {
        event = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
      } catch {
        throw new FixturePaymentError('webhook_invalid', 'fixture webhook body not JSON')
      }
      const held =
        event.paymentIntentId === undefined ? undefined : intents.get(event.paymentIntentId)
      if (held !== undefined && event.kind === 'payment.captured') held.status = 'succeeded'
      return {
        verified: true,
        eventId: event.id ?? `evt_fixture_${randomUUID()}`,
        kind: event.kind ?? ('ignored' as const),
        ...(event.paymentIntentId !== undefined && { paymentIntentId: event.paymentIntentId }),
        ...(event.amountMinor !== undefined && { amountMinor: event.amountMinor }),
        ...(event.currency !== undefined && { currency: event.currency }),
      }
    },
  }
}
