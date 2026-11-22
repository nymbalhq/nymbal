export type PaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'succeeded'
  | 'cancelled'
  | 'failed'

export interface PaymentIntentParams {
  amountMinor: number
  currency: string
  orderRef?: string
  customerId?: string
  /** Where the provider sends its receipt (Stripe's `receipt_email`). */
  receiptEmail?: string
  metadata?: Record<string, string>
  /**
   * A payment credential an agent was granted for this charge (a Stripe Shared Payment Token): the intent is confirmed
   * with it at creation. Only an adapter with the `delegated` capability takes one.
   */
  delegatedToken?: string
}

export interface PaymentIntent {
  id: string
  clientSecret: string
  amountMinor: number
  currency: string
  status: PaymentStatus
  providerPayload?: Record<string, unknown>
}

/**
 * What a checkout tells the shopper about their payment: `succeeded` once the order is confirmed, `requires_action`
 * while the provider waits on the shopper (a Stripe confirmation), `failed` with the reason when it will not complete.
 */
export interface CheckoutPayment {
  status: 'succeeded' | 'requires_action' | 'failed'
  reason?: string
}

/** A charge of a card the provider holds for a customer, made with no shopper present; it is captured in full. */
export interface SavedCardCharge {
  /** The provider's customer (Stripe `cus_…`). */
  customerRef: string
  /** The provider's payment method saved to that customer (Stripe `pm_…`). */
  paymentMethodRef: string
  amountMinor: number
  /** ISO 4217. */
  currency: string
  idempotencyKey: string
  metadata?: Record<string, string>
}

/**
 * How a saved-card charge ended. `card_refused`: the provider said no to the card (a decline, an expired card, an
 * authentication it asks for, or a card set-up it cannot use). `key_refused`: it refused the key (401, 403).
 * `provider_unreachable`: no answer, a server error, or an intent still processing, whose id is then given.
 */
export type SavedCardOutcome =
  | { status: 'captured'; paymentId: string; amountMinor: number; currency: string }
  | { status: 'card_refused'; detail: string }
  | { status: 'key_refused'; detail: string }
  | { status: 'provider_unreachable'; detail: string; paymentId?: string }

export interface PaymentCapture {
  paymentId: string
  capturedAmountMinor: number
  currency: string
  status: PaymentStatus
}

export interface Refund {
  refundId: string
  paymentId: string
  amountMinor: number
  currency: string
  reason: string | null
  status: 'pending' | 'succeeded' | 'failed'
}

/** A refund as the provider lists it: the idempotency key it was made under, or `null` for one made without a key. */
export interface ProviderRefund extends Refund {
  idempotencyKey: string | null
}

export interface WebhookResult {
  verified: boolean
  eventId: string
  kind: 'payment.captured' | 'payment.failed' | 'payment.refunded' | 'ignored'
  paymentIntentId?: string
  amountMinor?: number
  currency?: string
  reason?: string
  raw?: Record<string, unknown>
}
