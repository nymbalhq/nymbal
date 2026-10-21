import type { AdapterBase } from './adapter-base.js'
import type {
  PaymentIntent,
  PaymentIntentParams,
  PaymentCapture,
  Refund,
  PaymentStatus,
  WebhookResult,
} from '../domain/payment.js'
import type { CustomerProfile } from '../domain/customer.js'
import type { Review, ReviewModerationStatus, AggregateRating } from '../domain/review.js'

export interface CommerceAdapter extends AdapterBase {
  readonly providerName: string
}

// --- Payments ---------------------------------------------------------------

export interface RefundOptions {
  /** The same key on a retry makes the provider refund at most once. */
  idempotencyKey?: string
  /** The order's currency: what a provider that no longer holds the payment answers in. */
  currency?: string
}

/**
 * The storefront half of a payments adapter: which client-side driver collects the payment and the public values it
 * needs. GET /api/capabilities serves `options` to every shopper, so it holds public values only.
 */
export interface PaymentClient {
  driver: string
  options: Record<string, string>
}

export interface PaymentsAdapter extends CommerceAdapter {
  readonly kind: 'payments'
  /** How a storefront collects a payment; absent or `null` when there is no client step. */
  client?(): PaymentClient | null
  createPaymentIntent(params: PaymentIntentParams): Promise<PaymentIntent>
  capturePayment(intentId: string, amountMinor?: number): Promise<PaymentCapture>
  /** Throws `PaymentError('refund_rejected')` when no money moved, `PaymentError('refund_unknown')` when it may have. */
  refund(
    paymentId: string,
    amountMinor?: number,
    reason?: string,
    opts?: RefundOptions,
  ): Promise<Refund>
  getPaymentStatus(intentId: string): Promise<PaymentStatus>
  /** The intent as the provider holds it now, client secret included: what a shopper needs to pay it again. */
  getPaymentIntent(intentId: string): Promise<PaymentIntent>
  /** Cancels an intent that has not been paid; throws `PaymentError('cancel_refused')` when the provider will not
   *  (the intent is processing or already captured). */
  cancelPaymentIntent(intentId: string): Promise<void>
  parseWebhook(rawBody: Buffer | string, signature: string): Promise<WebhookResult>
}

// --- Email -----------------------------------------------------------------

export interface TransactionalEmail {
  template: string
  to: string
  vars: Record<string, unknown>
  locale?: string
}

export interface EmailSendResult {
  messageId: string | null
  accepted: boolean
}

export interface EmailAdapter extends CommerceAdapter {
  readonly kind: 'email'
  sendTransactional(params: TransactionalEmail): Promise<EmailSendResult>
  syncCustomerToList(customer: CustomerProfile): Promise<void>
  removeCustomerFromList(customerId: string): Promise<void>
}

// --- Reviews ---------------------------------------------------------------

export interface PaginationParams {
  limit?: number
  cursor?: string
}

export interface ReviewsResult {
  items: Review[]
  nextCursor: string | null
}

export interface ReviewSubmission {
  productId: string
  customerId: string | null
  orderId: string | null
  rating: number
  title: string
  body: string
}

export interface ReviewResult {
  review: Review
}

export interface ReviewsAdapter extends CommerceAdapter {
  readonly kind: 'reviews'
  getProductReviews(
    productId: string,
    params?: PaginationParams & { status?: ReviewModerationStatus },
  ): Promise<ReviewsResult>
  getAggregateRating(productId: string): Promise<AggregateRating>
  submitReview(review: ReviewSubmission): Promise<ReviewResult>
  requestReview(orderId: string): Promise<void>
}

// --- Search ----------------------------------------------------------------

export interface SearchDocument {
  id: string
  type: string
  fields: Record<string, unknown>
}

export interface IndexResult {
  indexed: number
}

export interface SearchParams {
  limit?: number
  cursor?: string
  filters?: Record<string, unknown>
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>
}

export interface SearchResult {
  items: SearchDocument[]
  total: number
  nextCursor: string | null
}

export interface FacetParams {
  /** Count only the documents this query matches. */
  query?: string
  limit?: number
  filters?: Record<string, unknown>
}

export interface Facet {
  field: string
  label: string
  values: Array<{ value: string; label?: string; count?: number }>
}

export interface SearchAdapter extends CommerceAdapter {
  readonly kind: 'search'
  index(documents: SearchDocument[]): Promise<IndexResult>
  remove(documentIds: string[]): Promise<void>
  search(query: string, params?: SearchParams): Promise<SearchResult>
  facet(field: string, params?: FacetParams): Promise<Facet>
}

// --- Analytics -------------------------------------------------------------

export interface AnalyticsAdapter extends CommerceAdapter {
  readonly kind: 'analytics'
  track(event: string, properties: Record<string, unknown>): Promise<void>
  identify(userId: string, traits: Record<string, unknown>): Promise<void>
}

// --- Shipping --------------------------------------------------------------

export interface ShippingRateParams {
  fromPostalCode: string
  toPostalCode: string
  toCountry: string
  weightGrams: number
  currency: string
}

export interface ShippingRate {
  carrier: string
  service: string
  amountMinor: number
  currency: string
  estimatedDays: number
}

export interface ShippingLabelParams {
  orderId: string
  carrier: string
  service: string
}

export interface ShippingLabel {
  labelUrl: string
  trackingNumber: string
  carrier: string
}

export interface ShippingTracking {
  status: string
  lastUpdateAt: string
}

export interface ShippingAdapter extends CommerceAdapter {
  readonly kind: 'shipping'
  rate(params: ShippingRateParams): Promise<ShippingRate[]>
  createLabel(params: ShippingLabelParams): Promise<ShippingLabel>
  track(trackingNumber: string): Promise<ShippingTracking>
}

// --- Tax -------------------------------------------------------------------

export interface TaxLine {
  amountMinor: number
  qty: number
}

export interface TaxCalculationParams {
  currency: string
  shippingCountry: string
  shippingRegion: string
  lines: TaxLine[]
}

export interface TaxCalculationResult {
  totalTaxMinor: number
  ratePerLine: Array<{ taxMinor: number }>
}

export interface TaxAdapter extends CommerceAdapter {
  readonly kind: 'tax'
  calculate(params: TaxCalculationParams): Promise<TaxCalculationResult>
}

// --- AI --------------------------------------------------------------------

export interface AiAdapter extends CommerceAdapter {
  readonly kind: 'ai'
  embed(texts: string[]): Promise<number[][]>
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>
}

/** The adapter interface each commerce slot takes: what a project injects for a slot whose provider is `custom`. */
export interface CommerceSlotAdapters {
  payments: PaymentsAdapter
  email: EmailAdapter
  reviews: ReviewsAdapter
  search: SearchAdapter
  analytics: AnalyticsAdapter
  shipping: ShippingAdapter
  tax: TaxAdapter
  ai: AiAdapter
}
