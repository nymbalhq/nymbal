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
import type { Address } from '../domain/order.js'
import type { Review, ReviewModerationStatus, AggregateRating } from '../domain/review.js'
import type { JsonSchemaObject } from './http.js'

/** A webhook request's headers, names lower-cased. */
export type WebhookHeaders = Record<string, string | string[] | undefined>

/** One event a webhook delivery carries; the kernel builds its envelope (id, source, correlation). */
export interface WebhookEventDraft {
  type: string
  payload: Record<string, unknown>
}

export interface WebhookDelivery {
  verified: boolean
  /** The provider's id for this delivery: what makes a retry of it a replay. */
  deliveryId: string
  events: WebhookEventDraft[]
}

export interface CommerceAdapter extends AdapterBase {
  readonly providerName: string
  /**
   * Takes a delivery to `POST /api/webhooks/<providerName>`: verifies its signature over `rawBody` (from whichever
   * header the provider signs in) and returns its events. The same bytes must give the same `deliveryId` and the same
   * events, so a provider's retry is processed once. Each event's type is `<providerName>.<event>.v<n>` (lower-case
   * words, `_` allowed), is listed in `producesEvents`, and its payload is a plain JSON object; a delivery breaking
   * this is refused whole. A kernel namespace (`order`, `payment`, ...) is never an adapter's. Not called on a
   * payments adapter, whose deliveries go through `parseWebhook`.
   */
  receiveWebhook?(rawBody: Buffer, headers: WebhookHeaders): Promise<WebhookDelivery>
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

/** What a reviews adapter can do; `capabilities()` of a reviews adapter answers a subset. */
export type ReviewsCapability = 'submit' | 'moderate' | 'aggregate' | 'invite' | 'widget'

/**
 * The kernel resolves `customerId`, `author` and `orderId` (the reviewer's paid order holding the product) before the
 * adapter sees a submission; an adapter never looks up customers or orders. An adapter without `submit` refuses it
 * with `ReviewRefusedError('submit_unsupported')`.
 */
export interface ReviewSubmission {
  productId: string
  customerId: string | null
  orderId: string | null
  author: { name: string; email: string } | null
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
  /**
   * Replaces the whole index with `documents`, so nothing outside them survives. Optional: without it a rebuild can
   * only `index` every document, and cannot remove ids the index holds beyond them (it has no way to list them).
   */
  replaceAll?(documents: Iterable<SearchDocument> | AsyncIterable<SearchDocument>): Promise<void>
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

/** What a shipping adapter does; each word is declared exactly when the method it names is present. */
export const SHIPPING_CAPABILITIES = ['rates', 'labels', 'tracking'] as const

/** `rates` has `rate`, `labels` has `createLabel` (and needs `rates`), `tracking` has `startTracking` and `receiveWebhook`. */
export type ShippingCapability = (typeof SHIPPING_CAPABILITIES)[number]

/** A parcel has all three dimensions or none. Grams and millimetres, each positive. */
export type Parcel =
  | { weightGrams: number; lengthMm?: never; widthMm?: never; heightMm?: never }
  | { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number }

export interface ShippingRateParams {
  from: Address
  to: Address
  parcel: Parcel
}

export interface ShippingRate {
  /** Opaque to the kernel: handed back unchanged as `ShippingLabelParams.rateId`. */
  id: string
  carrier: string
  service: string
  amountMinor: number
  currency: string
  estimatedDays: number | null
}

export interface ShippingLabelParams {
  rateId: string
}

export interface ShippingLabel {
  labelUrl: string
  trackingNumber: string
  carrier: string
  service: string
  amountMinor: number
  currency: string
}

export interface StartTrackingParams {
  trackingNumber: string
  /** As the merchant typed it; null leaves the carrier to the provider. */
  carrier: string | null
}

/**
 * `tracking`: the provider holds the number, now or from before. `refused`: it never will (an invalid number, an
 * unknown carrier, a refused key). An outage rejects instead, so the caller may try again.
 */
export type StartTrackingResult = { status: 'tracking' } | { status: 'refused'; reason: string }

export interface ShippingAdapter extends CommerceAdapter {
  readonly kind: 'shipping'
  capabilities(): readonly ShippingCapability[]
  rate?(params: ShippingRateParams): Promise<ShippingRate[]>
  createLabel?(params: ShippingLabelParams): Promise<ShippingLabel>
  startTracking?(params: StartTrackingParams): Promise<StartTrackingResult>
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

/** A tool the model may call. Its name matches `^[A-Za-z0-9_-]{1,64}$` and is unique among the tools of one request. */
export interface ChatTool {
  name: string
  description: string
  inputSchema: JsonSchemaObject
}

/** A call the model asked for, its arguments a JSON object. */
export interface ChatToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * One turn of a conversation. The first turn is the user's. An assistant turn's `content` may be empty only when it
 * has calls; each call is answered by one `tool` turn before the next user or assistant turn.
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: readonly ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }

export interface ChatOptions {
  /** Instructions for the whole conversation, sent in the provider's own system field. */
  system?: string
  /** The most tokens the answer may take; 1024 when omitted. */
  maxTokens?: number
  tools?: readonly ChatTool[]
  /** Aborting it closes the request and rejects `adapter.cancelled`. */
  signal?: AbortSignal
}

/** Why the answer ended: complete, cut at `maxTokens`, waiting on its tool calls, or anything else reported. */
export type ChatStopReason = 'end' | 'max_tokens' | 'tool_use' | 'other'

/** Tokens one request used, as the provider reports them; 0 where it reports none. */
export interface ChatUsage {
  /** Every input token, those read from or written to a prompt cache included. */
  inputTokens: number
  outputTokens: number
  /** Of `inputTokens`, those read from the provider's prompt cache, when it reports them. */
  cacheReadTokens?: number
  /** Of `inputTokens`, those written to the provider's prompt cache, when it reports them. */
  cacheWriteTokens?: number
}

export interface ChatResult {
  /** '' when the answer is calls only. */
  text: string
  stopReason: ChatStopReason
  usage: ChatUsage
  /** The model as the provider reports it. */
  model: string
  /** The calls the model asked for, in its order; [] when none. */
  toolCalls: ChatToolCall[]
}

/** What `chatStream` yields: text as it arrives, each call once its arguments are complete, and one `done` last. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'done'; result: ChatResult }

export interface AiAdapter extends CommerceAdapter {
  readonly kind: 'ai'
  /** The base URL its requests go to, for `nymbal doctor`; never a key. Absent when the adapter does not say. */
  readonly endpoint?: string
  embed(texts: string[]): Promise<number[][]>
  /** The text `chat` answers to a single user turn. */
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>
  /**
   * One request to the provider. Refused input, a provider failure and a timeout reject with an `AdapterError` whose
   * context is `{ provider, status? }` and which never carries the key.
   */
  chat(messages: readonly ChatMessage[], opts?: ChatOptions): Promise<ChatResult>
  /**
   * `chat` as it is generated: the text deltas concatenate to the `done` result's text and the `tool_call` events are
   * its calls in order. A stream broken after it started rejects `adapter.unavailable`; the whole stream is bounded as
   * one `chat`.
   */
  chatStream?(messages: readonly ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatStreamEvent>
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
