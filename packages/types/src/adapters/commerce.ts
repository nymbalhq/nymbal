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

export interface PaymentsAdapter extends CommerceAdapter {
  readonly kind: 'payments'
  createPaymentIntent(params: PaymentIntentParams): Promise<PaymentIntent>
  capturePayment(intentId: string, amountMinor?: number): Promise<PaymentCapture>
  refund(paymentId: string, amountMinor?: number, reason?: string): Promise<Refund>
  getPaymentStatus(intentId: string): Promise<PaymentStatus>
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
  limit?: number
  filters?: Record<string, unknown>
}

export interface FacetResult {
  field: string
  buckets: Array<{ value: string; count: number }>
}

export interface SearchAdapter extends CommerceAdapter {
  readonly kind: 'search'
  index(documents: SearchDocument[]): Promise<IndexResult>
  remove(documentIds: string[]): Promise<void>
  search(query: string, params?: SearchParams): Promise<SearchResult>
  facet(field: string, params?: FacetParams): Promise<FacetResult>
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
