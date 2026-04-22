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
  metadata?: Record<string, string>
}

export interface PaymentIntent {
  id: string
  clientSecret: string
  amountMinor: number
  currency: string
  status: PaymentStatus
  providerPayload?: Record<string, unknown>
}

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

export interface WebhookResult {
  verified: boolean
  eventId: string
  kind:
    | 'payment.captured'
    | 'payment.failed'
    | 'payment.refunded'
    | 'ignored'
  paymentIntentId?: string
  amountMinor?: number
  currency?: string
  reason?: string
  raw?: Record<string, unknown>
}
