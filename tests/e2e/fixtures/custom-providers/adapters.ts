import { randomUUID } from 'node:crypto'

// P2-05 decision 9: the swap fixture's own adapters, injected through the config's `adapters` export into the
// `custom` search and payments slots. Self-contained on purpose: nothing from @nymbalhq/platform (jiti would load a
// second instance of it, and of its error classes) and no runtime import from @nymbalhq/types. The shapes below are
// the SearchAdapter and PaymentsAdapter contracts written out; tests/contracts/custom-providers.test.ts runs both
// adapter contracts on them, which is where a drift from @nymbalhq/types shows.
//
// - search: in memory, `index` and `search` only (no `facet`). P2-07 decision 9: it matches by decision 3's rule (a
//   term is a maximal run of ASCII letters and digits after lowercasing; every query term prefix-matches a term of
//   the name, a SKU, a variant name or the description), filters by `categoryIds`, pages by an offset cursor and
//   reports an exact total. Results are in index order: the fixture promises no ranking;
// - payments: the native stub's `+stub-*` receipt-email rules, with `client()` null, so the storefront has no payment
//   step to render. A refund repeated with the same idempotency key answers the first refund again and moves no money
//   (P2-13 decision 4: the payments contract's idempotency case runs on this fixture too).

export type Health = { status: 'healthy' | 'degraded' | 'down'; detail?: string }

export interface Doc {
  id: string
  type: string
  fields: Record<string, unknown>
}

/** What the fixture's search offers: no `facet`, so the listing route sends no facets and no filter renders. */
export const FIXTURE_SEARCH_CAPABILITIES: readonly string[] = ['index', 'search']

/** Decision 3's terms of a text. */
function termsOf(text: unknown): string[] {
  return typeof text === 'string' ? (text.toLowerCase().match(/[a-z0-9]+/g) ?? []) : []
}

/** Every searchable term of a doc: name, each variant's SKU and name, description. */
function docTerms(doc: Doc): string[] {
  const variants = Array.isArray(doc.fields['variants'])
    ? (doc.fields['variants'] as Array<Record<string, unknown>>)
    : []
  return [
    ...termsOf(doc.fields['name']),
    ...variants.flatMap((v) => [...termsOf(v['sku']), ...termsOf(v['name'])]),
    ...termsOf(doc.fields['description']),
  ]
}

/** The fixture's cursor for an offset: the decimal offset, base64url. Encodes anything; only search validates. */
export function encodeFixtureCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeFixtureCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!/^\d+$/.test(text) || encodeFixtureCursor(Number(text)) !== cursor) {
    throw new Error(`malformed search cursor ${JSON.stringify(cursor)}`)
  }
  return Number(text)
}

export function createFixtureSearchAdapter() {
  const docs = new Map<string, Doc>()
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
      const offset = params?.cursor === undefined ? 0 : decodeFixtureCursor(params.cursor)
      const q = termsOf(query)
      if (q.length === 0) return { items: [], total: 0, nextCursor: null }
      const category = params?.filters?.['categoryIds']
      const hits = [...docs.values()].filter((doc) => {
        if (category !== undefined) {
          const ids = doc.fields['categoryIds']
          if (!Array.isArray(ids) || !ids.includes(category)) return false
        }
        const terms = docTerms(doc)
        return q.every((t) => terms.some((d) => d.startsWith(t)))
      })
      const limit = params?.limit ?? 20
      const end = offset + limit
      return {
        items: hits.slice(offset, end),
        total: hits.length,
        nextCursor: end < hits.length ? encodeFixtureCursor(end) : null,
      }
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

export interface Refunded {
  refundId: string
  paymentId: string
  amountMinor: number
  currency: string
  reason: string | null
  status: 'succeeded'
}

export function createFixturePaymentsAdapter() {
  const intents = new Map<string, Intent>()
  /** The first answer to each idempotency key: a retry gets it back. */
  const refunds = new Map<string, Refunded>()
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
    ): Promise<Refunded> {
      const replay =
        opts?.idempotencyKey === undefined ? undefined : refunds.get(opts.idempotencyKey)
      if (replay !== undefined) return replay
      const answer = (amount: number, currency: string): Refunded => {
        const refund: Refunded = {
          refundId: `re_fixture_${randomUUID()}`,
          paymentId,
          amountMinor: amount,
          currency,
          reason: reason ?? null,
          status: 'succeeded' as const,
        }
        if (opts?.idempotencyKey !== undefined) refunds.set(opts.idempotencyKey, refund)
        return refund
      }
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
