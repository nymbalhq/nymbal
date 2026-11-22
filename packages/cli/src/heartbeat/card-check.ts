import { randomUUID } from 'node:crypto'
import {
  currencyExponent,
  errorText,
  type PaymentsAdapter,
  type Refund,
  type SavedCardOutcome,
} from '@nymbalhq/types'
import { timed, type HeartbeatResult } from './result.js'

// The card check, at the payments adapter in this process and never through an order: the merchant's saved card is
// charged and captured, then refunded exactly what was captured. Each key comes from the run, so a retried call never
// charges or refunds twice.

export interface CardCheckTarget {
  /** The provider's customer id. */
  customer: string
  /** The provider's payment method id, saved to that customer. */
  paymentMethod: string
  amountMinor: number
  /** ISO 4217: the store's currency. */
  currency: string
}

/** `amountMinor` in `currency`'s major unit, with its code: `1.00 GBP`, `100 JPY`. */
function money(amountMinor: number, currency: string): string {
  const digits = currencyExponent(currency)
  return `${(amountMinor / 10 ** digits).toFixed(digits)} ${currency}`
}

/** Never throws: each outcome, the charge's and the refund's, is a status. */
export async function runCardCheck(
  payments: PaymentsAdapter,
  card: CardCheckTarget,
  options: { runId?: string } = {},
): Promise<HeartbeatResult> {
  const finish = timed('card')
  const runId = options.runId ?? randomUUID()
  if (payments.chargeSavedCard === undefined) {
    return finish(
      'failed',
      `the payments provider ${payments.providerName} cannot charge a saved card`,
    )
  }

  let charged: SavedCardOutcome
  try {
    charged = await payments.chargeSavedCard({
      customerRef: card.customer,
      paymentMethodRef: card.paymentMethod,
      amountMinor: card.amountMinor,
      currency: card.currency,
      idempotencyKey: `heartbeat-charge-${runId}`,
      metadata: { heartbeat_run: runId },
    })
  } catch (err) {
    // The adapter broke its promise not to throw: whether money moved is unknown.
    return finish('failed', `the charge threw: ${errorText(err)}`)
  }
  if (charged.status !== 'captured') {
    const held = charged.status === 'provider_unreachable' ? charged.paymentId : undefined
    return finish(charged.status, charged.detail, held === undefined ? {} : { paymentId: held })
  }

  const { paymentId } = charged
  const captured = money(charged.amountMinor, charged.currency)
  const leftOnCard = (why: string) =>
    finish(
      'refund_failed',
      `payment ${paymentId} of ${captured} was captured and ${why}: refund it in the provider's dashboard`,
      { paymentId },
    )
  let refund: Refund
  try {
    refund = await payments.refund(paymentId, charged.amountMinor, 'requested_by_customer', {
      idempotencyKey: `heartbeat-refund-${runId}`,
      currency: charged.currency,
    })
  } catch (err) {
    return leftOnCard(`its refund was refused or its outcome is unknown (${errorText(err)})`)
  }
  if (refund.status === 'failed') return leftOnCard(`its refund ${refund.refundId} failed`)
  if (refund.amountMinor !== charged.amountMinor) {
    return leftOnCard(`only ${money(refund.amountMinor, charged.currency)} was refunded`)
  }
  return refund.status === 'pending'
    ? finish('ok', `${captured} charged, refund pending`, { paymentId, refund: 'pending' })
    : finish('ok', `${captured} charged and refunded`, { paymentId, refund: 'succeeded' })
}
