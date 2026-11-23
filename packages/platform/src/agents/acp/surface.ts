import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CART_LINE_MAX_QTY,
  CheckoutError,
  NotFoundError,
  PaymentError,
  type AgentRoute,
  type AgentRouteRequest,
  type AgentSurfaceAdapter,
  type AgentSurfaceUrls,
  type Caller,
  type Cart,
  type CheckoutQuote,
  type DocumentStoreAdapter,
  type Logger,
  type Order,
  type PromotionEffect,
  type ResponseEnvelope,
  type ToolSurface,
} from '@nymbalhq/types'
import { requestHash } from '../../audit/idempotency.js'
import { CODE_MAX_LENGTH, isCartCode } from '../../routes/cart.js'
import { MAX_CART_CODES } from '../../services/cart-service.js'
import type { BeginCheckoutResult, CheckoutService } from '../../services/checkout-service.js'
import { cartCodes, cartTotals } from '../../services/promotions-quote.js'
import { shippingOptions, type ShippingRate } from '../../services/shipping-quote.js'
import { formatMoney } from '../../money.js'
import { barcodesOf, ucpProduct, type ListedProduct } from '../catalog.js'
import { toNymbalAddress } from './address.js'
import {
  ACP_BASE_PATH,
  ACP_CAPABILITIES,
  ACP_CREDENTIAL,
  ACP_HANDLER_ID,
  ACP_SESSIONS,
  ACP_VERSION,
  acpHandler,
} from './constants.js'
import { acpKeyMatcher, type AcpKey } from './keys.js'
import {
  acpDiscounts,
  acpSession,
  cartLines,
  discountWarnings,
  missingMessages,
  orderLines,
  orderTotals,
  STANDARD_FULFILLMENT,
  type AcpMessage,
  type AcpOrder,
  type AcpStatus,
  type SessionPricing,
  type StoredSession,
} from './session.js'

export interface AcpLink {
  type: string
  url: string
  title?: string | undefined
}

/**
 * Runs a POST once per Idempotency-Key of the ACP key that sent it (`keyName`): its stored answer is replayed, and the
 * Idempotency-Key with another body is refused.
 */
export type AcpIdempotent = (
  command: string,
  request: { key: string; hash: string; keyName: string },
  run: () => Promise<ResponseEnvelope>,
) => Promise<ResponseEnvelope>

export interface AcpSurfaceDeps {
  /** The app's route tools: every cart change and catalogue read runs through them as the calling agent. */
  mcp: Pick<ToolSurface, 'call'>
  /** The live guest cart a token names, or null for an unknown, expired or customer-claimed one. */
  cart: (token: string) => Promise<Cart | null>
  /** The slug of the product a variant id belongs to, or null. */
  variants: (variantId: string) => Promise<string | null>
  orders: {
    /** The order the cart became, if it became one. */
    converted(token: string): Promise<Order | null>
    /** The cart's order still waiting on its payment. */
    pending(token: string): Promise<Order | null>
  }
  sessions: DocumentStoreAdapter
  checkout: Pick<CheckoutService, 'beginCheckout' | 'quote'>
  /** `commerce.shipping.rates`: which options an address is offered on a store that prices by its table. */
  shippingRates: readonly ShippingRate[]
  /** What prices shipping: no table (one free option), the table, or the carrier's rates. */
  shippingPricing: 'free' | 'table' | 'carrier'
  idempotent: AcpIdempotent
  payments: { providerName: string; environment: 'test' | 'production' }
  urls: () => AgentSurfaceUrls
  config: { keys: readonly AcpKey[]; links: readonly AcpLink[]; merchantId?: string | undefined }
  store: { currency: string; name: string }
  logger: Logger
}

/** The most distinct items one session holds. */
const MAX_ITEMS = 50
/** The feed reads the catalogue a page at a time. */
const FEED_PAGE = 100
const SUPPORTED_VERSIONS = [ACP_VERSION]
const MAX_IDEMPOTENCY_KEY = 255
const CODES_DOWN =
  'The discount codes could not be checked just now. Send discounts.codes again in an update shortly.'

// --- Requests ------------------------------------------------------------------------------------------------------

const address = z.object({
  name: z.string(),
  line_one: z.string(),
  line_two: z.string().optional(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  postal_code: z.string(),
  company: z.string().optional(),
})

const buyer = z.object({
  email: z.email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  full_name: z.string().optional(),
  phone_number: z.string().optional(),
})

const fulfillmentDetails = z.object({
  name: z.string().optional(),
  phone_number: z.string().optional(),
  email: z.email().optional(),
  address: address.optional(),
})

/** ACP's `Item` with the lenient `quantity` the store also takes (the pinned `Item` has none). */
const item = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  unit_amount: z.number().int().optional(),
  quantity: z.number().int().min(1).optional(),
})

const selectedFulfillment = z.object({
  type: z.enum(['shipping', 'digital', 'pickup', 'local_delivery']),
  option_id: z.string(),
  item_ids: z.array(z.string()),
})

/** Request fields the pinned schema allows that this store reads nothing from. */
const ignored = z.unknown().optional()

const discounts = z
  .object({ codes: z.array(z.string()) })
  .strict()
  .optional()
/** The protocol's deprecated spelling of `discounts.codes`, read when `discounts` is absent. */
const coupons = z.array(z.string()).optional()

const createRequest = z
  .object({
    line_items: z.array(item).min(1),
    currency: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    buyer: buyer.optional(),
    fulfillment_details: fulfillmentDetails.optional(),
    fulfillment_groups: ignored,
    affiliate_attribution: ignored,
    coupons,
    discounts,
    locale: ignored,
    timezone: ignored,
    quote_id: ignored,
    metadata: ignored,
    order_notes: ignored,
  })
  .strict()

const updateRequest = z
  .object({
    buyer: buyer.optional(),
    line_items: z.array(item).optional(),
    fulfillment_details: fulfillmentDetails.optional(),
    selected_fulfillment_options: z.array(selectedFulfillment).optional(),
    fulfillment_groups: ignored,
    coupons,
    discounts,
    order_notes: ignored,
  })
  .strict()

const completeRequest = z
  .object({
    payment_data: z.object({
      handler_id: z.string().optional(),
      instrument: z
        .object({
          type: z.string(),
          credential: z.object({ type: z.string(), token: z.string().min(1) }),
        })
        .optional(),
      billing_address: address.optional(),
      purchase_order_number: z.string().optional(),
    }),
    buyer: ignored,
    authentication_result: ignored,
    affiliate_attribution: ignored,
    risk_signals: ignored,
    marketing_consents: ignored,
    order_notes: ignored,
  })
  .strict()

const cancelRequest = z.object({ intent_trace: ignored })

type Item = z.infer<typeof item>

// --- Answers -------------------------------------------------------------------------------------------------------

/** ACP's `Error`: what a request the store cannot answer with a session gets. */
function acpError(
  status: number,
  code: string,
  message: string,
  extra: { param?: string; headers?: Record<string, string>; versions?: boolean } = {},
): ResponseEnvelope {
  return {
    status,
    ...(extra.headers !== undefined && { headers: extra.headers }),
    body: {
      type: status >= 500 ? 'processing_error' : 'invalid_request',
      code,
      message,
      ...(extra.param !== undefined && { param: extra.param }),
      ...(extra.versions === true && { supported_versions: SUPPORTED_VERSIONS }),
    },
  }
}

const invalid = (message: string, param: string) => acpError(400, 'invalid', message, { param })
const notFound = (id: string) =>
  acpError(404, 'not_found', `No checkout session has the id ${JSON.stringify(id)}`)
const closed = () =>
  acpError(405, 'session_closed', 'This checkout session is completed or canceled')
const inFlight = () =>
  acpError(409, 'idempotency_in_flight', 'A payment for this checkout session is under way', {
    headers: { 'retry-after': '1' },
  })

function message(code: string, content: string, param?: string): AcpMessage {
  return {
    type: 'error',
    code,
    content_type: 'plain',
    content,
    ...(param !== undefined && { param }),
  }
}

/** A Zod issue path as the RFC 9535 JSONPath an ACP error points with. */
function jsonPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (at, key) => (typeof key === 'number' ? `${at}[${key}]` : `${at}.${String(key)}`),
    '$',
  )
}

function parsed<T>(
  schema: z.ZodType<T>,
  body: unknown,
): { ok: true; data: T } | { ok: false; answer: ResponseEnvelope } {
  const result = schema.safeParse(body ?? {})
  if (result.success) return { ok: true, data: result.data }
  const issue = result.error.issues[0]!
  const keys = issue.code === 'unrecognized_keys' ? issue.keys : []
  const path = keys.length > 0 ? [...issue.path, keys[0]!] : issue.path
  return { ok: false, answer: invalid(issue.message, jsonPath(path)) }
}

function header(request: AgentRouteRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

// --- Lines ---------------------------------------------------------------------------------------------------------

/** A requested line: the variant, its summed quantity, and the request index it is reported at. */
interface Line {
  variantId: string
  qty: number
  index: number
}

/** The request's items with each id's quantities summed, at the index of its first mention. */
function mergeItems(items: readonly Item[]): Line[] {
  const lines = new Map<string, Line>()
  for (const [index, entry] of items.entries()) {
    const seen = lines.get(entry.id)
    const qty = entry.quantity ?? 1
    if (seen === undefined) lines.set(entry.id, { variantId: entry.id, qty, index })
    else seen.qty += qty
  }
  return [...lines.values()]
}

const itemParam = (line: Line) => `$.line_items[${line.index}].id`

// --- Codes ---------------------------------------------------------------------------------------------------------

/** The codes a request asks the cart to hold, each trimmed, with the field they came in for pointing at them. */
interface AskedCodes {
  codes: Array<{ code: string; index: number }>
  param: '$.discounts.codes' | '$.coupons'
}

/**
 * `discounts.codes`, else `coupons`, checked as the cart's code route checks a code, before anything changes: one the
 * route would refuse, or more than five distinct, is refused here. A code repeated in another case is asked once.
 */
function askedCodes(data: {
  discounts?: { codes: string[] } | undefined
  coupons?: string[] | undefined
}): { ok: true; asked: AskedCodes | undefined } | { ok: false; answer: ResponseEnvelope } {
  const param = data.discounts !== undefined ? '$.discounts.codes' : '$.coupons'
  const list = data.discounts?.codes ?? data.coupons
  if (list === undefined) return { ok: true, asked: undefined }
  const codes: AskedCodes['codes'] = []
  for (const [index, raw] of list.entries()) {
    const code = raw.trim()
    if (!isCartCode(code)) {
      return {
        ok: false,
        answer: invalid(`A code is 1 to ${CODE_MAX_LENGTH} characters`, `${param}[${index}]`),
      }
    }
    if (!codes.some((c) => c.code.toLowerCase() === code.toLowerCase())) {
      codes.push({ code, index })
    }
  }
  if (codes.length > MAX_CART_CODES) {
    return { ok: false, answer: invalid(`A session holds at most ${MAX_CART_CODES} codes`, param) }
  }
  return { ok: true, asked: { codes, param } }
}

/** What a refused cart call answers, by the cart route's code. */
const CART_REFUSAL: Record<string, string> = {
  'cart.variant_missing': 'invalid_item_id',
  'cart.qty_limit': 'quantity_exceeded',
}

/**
 * The Agentic Commerce Protocol's checkout over REST (`/api/acp/**`): a session is a guest cart, opened and changed
 * through the route tools as the calling agent, and completed by charging the agent's delegated payment through the
 * store's checkout. Every request is held to one of the store's ACP keys, the pinned API version and, on a POST, an
 * Idempotency-Key, in that order, before anything is read. The matched key's name is the calling agent.
 */
export function createAcpSurface(deps: AcpSurfaceDeps): AgentSurfaceAdapter {
  const { mcp, config } = deps
  const matchKey = acpKeyMatcher(config.keys)
  const handler = () =>
    acpHandler({
      psp: deps.payments.providerName,
      environment: deps.payments.environment,
      merchantId: config.merchantId,
    })

  function callerOf(request: AgentRouteRequest, agent: string): Caller {
    return { agent: { name: agent }, ip: request.ip }
  }

  /** The name of the key the bearer is, or null for any other bearer. */
  function keyOf(request: AgentRouteRequest): string | null {
    const authorization = header(request, 'authorization') ?? ''
    const bearer = /^Bearer (.+)$/i.exec(authorization)?.[1] ?? ''
    return matchKey(bearer)?.name ?? null
  }

  /** The version and, on a POST, the Idempotency-Key: the first that fails answers. */
  function refusal(request: AgentRouteRequest, post: boolean): ResponseEnvelope | null {
    const version = header(request, 'api-version')
    if (version === undefined || version === '') {
      return acpError(400, 'missing_api_version', 'The API-Version header is required', {
        versions: true,
      })
    }
    if (version !== ACP_VERSION) {
      return acpError(400, 'unsupported_api_version', `API-Version ${version} is not served`, {
        versions: true,
      })
    }
    if (post) {
      const key = header(request, 'idempotency-key') ?? ''
      if (key === '' || key.length > MAX_IDEMPOTENCY_KEY) {
        return acpError(
          400,
          'idempotency_key_required',
          `An Idempotency-Key of 1-${MAX_IDEMPOTENCY_KEY} characters is required`,
        )
      }
    }
    return null
  }

  // --- Pricing a session -----------------------------------------------------------------------------------------

  /** What a session shows before it is priced: the free standard option on a store with no table, else none. */
  const unpriced: SessionPricing = {
    kind: 'unpriced',
    options: deps.shippingPricing === 'free' ? [STANDARD_FULFILLMENT] : [],
  }

  /**
   * The option ids the session's cart is offered at an address. A table's ids never depend on the goods, only their
   * amounts do; a carrier's do (a heavier parcel loses services), so they are its quote's. Null when that quote is
   * refused: the answer renders the refusal as `price()` does.
   */
  async function offeredIds(
    token: string,
    details: StoredSession['fulfillment_details'],
  ): Promise<string[] | null> {
    if (details?.address === undefined) return unpriced.options.map((option) => option.id)
    const shipTo = toNymbalAddress(details.address, details.phone_number)
    if (deps.shippingPricing !== 'carrier') {
      return shippingOptions(deps.shippingRates, shipTo, 0).map((option) => option.id)
    }
    try {
      const quote = await deps.checkout.quote({ cartToken: token, shippingAddress: shipTo })
      return quote.options.map((option) => option.id)
    } catch (err) {
      if (err instanceof CheckoutError && err.code === 'checkout.cart_empty') return null
      if (quoteRefusal(err) === null) throw err
      return null
    }
  }

  function info(content: string): AcpMessage {
    return {
      type: 'info',
      severity: 'high',
      resolution: 'recoverable',
      content_type: 'plain',
      content,
    }
  }

  /** Why a quote was refused, as the session's status and message; null for a refusal a session does not show. */
  function quoteRefusal(err: unknown): AcpMessage | null {
    if (!(err instanceof CheckoutError)) return null
    switch (err.code) {
      case 'checkout.tax_unavailable':
        return info(
          'The tax for this order could not be worked out just now. Retry this request shortly.',
        )
      case 'checkout.promotions_unavailable':
        return info(
          'The discounts for this order could not be worked out just now. Retry this request shortly.',
        )
      case 'checkout.shipping_unavailable':
        return info(
          'The delivery price for this order could not be worked out just now. Retry this request shortly.',
        )
      case 'checkout.no_shipping':
        return message(
          'region_restricted',
          'The store does not deliver to this address.',
          '$.fulfillment_details.address',
        )
      case 'checkout.variant_missing':
        return message('out_of_stock', 'An item is no longer in stock.', '$.line_items')
      default:
        return null
    }
  }

  interface Priced {
    pricing: SessionPricing
    quote?: CheckoutQuote
    /** Why the session could not be priced; it is then not ready for payment. */
    refusal?: AcpMessage
    /** The refusal was the promotions engine's. */
    promotionsDown?: boolean
    /** The money effects the totals shown applied. */
    applied: readonly PromotionEffect[]
  }

  /**
   * An open session with an address, priced by the checkout quote at its stored choice, or at the address's first
   * option when it no longer offers that one; a session with an order, at the order's columns; any other unpriced.
   */
  async function price(loaded: Loaded): Promise<Priced> {
    if (loaded.status === 'completed' || loaded.status === 'complete_in_progress') {
      const { order } = loaded
      // The option the order recorded; an order from a store with no table was placed at the free standard one.
      const shipping = (order.metadata as { shipping?: { optionId: string; name: string } })
        .shipping
      const option =
        shipping === undefined
          ? STANDARD_FULFILLMENT
          : { id: shipping.optionId, name: shipping.name, amountMinor: 0, estimatedDays: null }
      return {
        pricing: {
          kind: 'priced',
          options: [{ ...option, amountMinor: order.shippingTotalMinor }],
          optionId: option.id,
          totals: orderTotals(order),
        },
        applied: orderPromotions(order).effects,
      }
    }
    if (loaded.status === 'canceled') {
      return { pricing: { kind: 'unpriced', options: [STANDARD_FULFILLMENT] }, applied: [] }
    }
    // Before a quote the session shows what its cart comes to: the lines less the codes' discount.
    const totals = cartTotals(loaded.cart)
    const atCart: Priced = { pricing: { ...unpriced, totals }, applied: totals.applied }
    const details = loaded.stored.fulfillment_details
    if (details?.address === undefined) return atCart
    const asked = {
      cartToken: loaded.token,
      shippingAddress: toNymbalAddress(details.address, details.phone_number),
      ...(loaded.stored.buyer?.email !== undefined && { email: loaded.stored.buyer.email }),
    }
    const chosen = loaded.stored.selected_fulfillment_options?.[0]?.option_id
    try {
      let quote: CheckoutQuote
      try {
        quote = await deps.checkout.quote({
          ...asked,
          ...(chosen !== undefined && { shippingOptionId: chosen }),
        })
      } catch (err) {
        if (
          !(err instanceof CheckoutError && err.code === 'checkout.shipping_option_unavailable')
        ) {
          throw err
        }
        quote = await deps.checkout.quote(asked)
      }
      return {
        pricing: {
          kind: 'priced',
          options: quote.options,
          optionId: quote.shippingOptionId,
          totals: quote.totals,
        },
        quote,
        applied: quote.totals.applied,
      }
    } catch (err) {
      // A cart emptied outside the session has nothing to price; it reads as its lines do.
      if (err instanceof CheckoutError && err.code === 'checkout.cart_empty') return atCart
      const refusal = quoteRefusal(err)
      if (refusal === null) throw err
      return {
        ...atCart,
        refusal,
        promotionsDown: (err as CheckoutError).code === 'checkout.promotions_unavailable',
      }
    }
  }

  /** What an order recorded of its promotions: the codes accepted and the money effects they applied. */
  function orderPromotions(order: Order): { codes: string[]; effects: PromotionEffect[] } {
    const recorded = (
      order.metadata as { promotions?: { codes?: string[]; effects?: PromotionEffect[] } }
    ).promotions
    return { codes: recorded?.codes ?? [], effects: recorded?.effects ?? [] }
  }

  // --- Reading a session -----------------------------------------------------------------------------------------

  type Loaded = { token: string; stored: StoredSession } & (
    | { status: 'completed'; order: Order }
    | { status: 'complete_in_progress'; order: Order; cart: Cart }
    | { status: 'canceled' | 'ready_for_payment' | 'not_ready_for_payment'; cart: Cart }
  )

  /** A session's state, derived on every read: its order first, then its cancel mark, then what it still lacks. */
  async function load(token: string): Promise<Loaded | null> {
    const stored = (await deps.sessions.get<StoredSession>(ACP_SESSIONS, token)) ?? {}
    const converted = await deps.orders.converted(token)
    if (converted !== null) return { token, status: 'completed', order: converted, stored }
    const cart = await deps.cart(token)
    if (cart === null) return null
    const pending = await deps.orders.pending(token)
    if (pending !== null && pending.paymentIntentId !== null) {
      return { token, status: 'complete_in_progress', order: pending, cart, stored }
    }
    if (stored.canceledAt !== undefined) return { token, status: 'canceled', cart, stored }
    const ready = missingMessages(stored).length === 0
    return { token, status: ready ? 'ready_for_payment' : 'not_ready_for_payment', cart, stored }
  }

  function permalink(order: Order, key?: string): string {
    const { storefront, api } = deps.urls()
    const base = `${storefront ?? api}/order/${encodeURIComponent(order.orderNumber)}`
    return key === undefined ? base : `${base}?key=${encodeURIComponent(key)}`
  }

  interface RenderOptions {
    messages?: AcpMessage[]
    status?: AcpStatus
    orderKey?: string
    /** A POST's answer: the priced total and option are stored as what `complete` acknowledges. */
    write?: boolean
    /** The total moved since the agent was last answered: the answer warns the buyer to review it. */
    priceChanged?: boolean
    /** A code could not be added because the promotions engine was down: the session says to send the codes again. */
    codesDown?: boolean
  }

  async function render(
    loaded: Loaded,
    opts: RenderOptions = {},
  ): Promise<Record<string, unknown>> {
    const { pricing, quote, refusal, promotionsDown, applied } = await price(loaded)
    if (opts.write === true && quote !== undefined) {
      const quoted = { totalMinor: quote.totals.totalMinor, optionId: quote.shippingOptionId }
      await save(loaded.token, { ...loaded.stored, quoted })
    }
    const common = {
      stored: loaded.stored,
      links: config.links,
      handler: handler(),
      pricing,
    }
    if (loaded.status === 'completed') {
      const { order } = loaded
      const recorded = orderPromotions(order)
      const acpOrder: AcpOrder = {
        type: 'order',
        id: order.id,
        order_number: order.orderNumber,
        checkout_session_id: loaded.token,
        permalink_url: permalink(order, opts.orderKey),
        status: order.status === 'cancelled' ? 'canceled' : order.status,
      }
      return acpSession({
        ...common,
        id: loaded.token,
        status: 'completed',
        lines: orderLines(order),
        currency: order.currency,
        messages: [],
        order: acpOrder,
        discounts: acpDiscounts(
          recorded.codes.map((code) => ({ code, status: 'accepted' })),
          applied,
        ),
      })
    }
    const { cart } = loaded
    const lines =
      loaded.status === 'complete_in_progress' ? orderLines(loaded.order) : cartLines(cart)
    const missing =
      loaded.status === 'ready_for_payment' || loaded.status === 'not_ready_for_payment'
        ? missingMessages(loaded.stored)
        : []
    const changed =
      opts.priceChanged === true && quote !== undefined
        ? [priceChange(quote.totals.totalMinor, quote.currency)]
        : []
    const discounts = acpDiscounts(cartCodes(cart.promotions).codes, applied)
    // One word on the engine being down: the codes' message stands in for the quote's own.
    const codesDown = opts.codesDown === true ? [info(CODES_DOWN)] : []
    const refused =
      refusal === undefined || (opts.codesDown === true && promotionsDown === true) ? [] : [refusal]
    return acpSession({
      ...common,
      id: loaded.token,
      status:
        refusal === undefined && opts.codesDown !== true
          ? (opts.status ?? loaded.status)
          : 'not_ready_for_payment',
      lines,
      currency: cart.currency,
      expiresAt: cart.expiresAt,
      messages: [
        ...missing,
        ...refused,
        ...codesDown,
        ...discountWarnings(discounts),
        ...changed,
        ...(opts.messages ?? []),
      ],
      discounts,
    })
  }

  function priceChange(totalMinor: number, currency: string): AcpMessage {
    return {
      type: 'warning',
      code: 'price_change',
      severity: 'high',
      resolution: 'requires_buyer_review',
      content_type: 'plain',
      content: `The total is now ${formatMoney(totalMinor, currency)}. Review it with the buyer before completing the checkout.`,
    }
  }

  async function answer(
    token: string,
    status: number,
    opts?: RenderOptions,
  ): Promise<ResponseEnvelope> {
    const loaded = await load(token)
    if (loaded === null) return notFound(token)
    return { status, body: await render(loaded, opts) }
  }

  async function save(token: string, stored: StoredSession): Promise<void> {
    const cart = await deps.cart(token)
    const ttl = cart === null ? 0 : Math.ceil((Date.parse(cart.expiresAt) - Date.now()) / 1000)
    await deps.sessions.put(ACP_SESSIONS, token, stored, ttl > 0 ? { ttl } : {})
  }

  // --- Lines -----------------------------------------------------------------------------------------------------

  /** Every line checked against the catalogue before any cart call: the first refusal answers, in request order. */
  async function check(lines: readonly Line[], caller: Caller): Promise<ResponseEnvelope | null> {
    if (lines.length > MAX_ITEMS) {
      return invalid(`A session holds at most ${MAX_ITEMS} distinct items`, '$.line_items')
    }
    const products = new Map<string, ListedProduct | null>()
    for (const line of lines) {
      if (line.qty > CART_LINE_MAX_QTY) {
        return acpError(
          400,
          'quantity_exceeded',
          `An item's quantity is at most ${CART_LINE_MAX_QTY}`,
          { param: itemParam(line) },
        )
      }
      const slug = await deps.variants(line.variantId)
      let product = slug === null ? null : products.get(slug)
      if (slug !== null && product === undefined) {
        const read = await mcp.call('products_get', { slug }, caller)
        product =
          read.isError === true ? null : (read.structuredContent as unknown as ListedProduct)
        products.set(slug, product)
      }
      const variant =
        product?.priceRange === null
          ? undefined
          : product?.variants.find((v) => v.id === line.variantId)
      if (variant === undefined) {
        return acpError(
          400,
          'invalid_item_id',
          `Nothing this store sells has the id ${JSON.stringify(line.variantId)}`,
          { param: itemParam(line) },
        )
      }
      if (variant.stock < line.qty) {
        return acpError(400, 'out_of_stock', `Only ${variant.stock} of this item are in stock`, {
          param: itemParam(line),
        })
      }
    }
    return null
  }

  /** Sets the cart's lines from `from` to exactly `to`; the first refused call answers, leaving what it had done. */
  async function setLines(
    token: string,
    from: ReadonlyMap<string, number>,
    to: readonly Line[],
    caller: Caller,
  ): Promise<ResponseEnvelope | null> {
    const wanted = new Set(to.map((line) => line.variantId))
    for (const variantId of from.keys()) {
      if (!wanted.has(variantId))
        await mcp.call('cart_removeItem', { cart: token, variantId }, caller)
    }
    for (const line of to) {
      const had = from.get(line.variantId)
      if (had === line.qty) continue
      const result =
        had === undefined
          ? await mcp.call(
              'cart_addItem',
              { cart: token, variantId: line.variantId, qty: line.qty },
              caller,
            )
          : await mcp.call(
              'cart_updateItem',
              { cart: token, variantId: line.variantId, qty: line.qty },
              caller,
            )
      if (result.isError !== true) continue
      const { code } = (result.structuredContent ?? {}) as { code?: unknown }
      const acpCode = (typeof code === 'string' && CART_REFUSAL[code]) || 'out_of_stock'
      return acpError(400, acpCode, 'The store could not hold this item', {
        param: itemParam(line),
      })
    }
    return null
  }

  function quantities(cart: Cart | null): Map<string, number> {
    return new Map((cart?.items ?? []).map((i) => [i.variantId, i.qty]))
  }

  /** The cart set to `to`, or put back to `before` when a call is refused midway (stock taken since the check). */
  async function replaceLines(
    token: string,
    before: Cart,
    to: readonly Line[],
    caller: Caller,
  ): Promise<ResponseEnvelope | null> {
    const refused = await setLines(token, quantities(before), to, caller)
    if (refused === null) return null
    const previous = before.items.map((i, index) => ({ variantId: i.variantId, qty: i.qty, index }))
    const restored = await setLines(token, quantities(await deps.cart(token)), previous, caller)
    if (restored !== null) {
      deps.logger.warn(
        { session: token },
        'an ACP session’s previous lines could not all be restored',
      )
    }
    return refused
  }

  /**
   * What a code tool's refusal answers, by the cart route's code, `at` the code it was asked for; null when the codes
   * could not be checked (the engine down, or a refusal the agent can do nothing about but send them again).
   */
  function codeRefusal(
    result: { structuredContent?: Record<string, unknown> | undefined },
    asked: AskedCodes,
    at: string,
    token: string,
  ): ResponseEnvelope | null {
    const refused = result.structuredContent?.['code']
    switch (refused) {
      case 'cart.code_invalid':
        return invalid(`A code is 1 to ${CODE_MAX_LENGTH} characters`, at)
      case 'cart.code_limit':
        return invalid(`A session holds at most ${MAX_CART_CODES} codes`, asked.param)
      case 'cart.missing':
        return notFound(token)
      case 'cart.promotions_unavailable':
        return null
      default:
        deps.logger.warn({ session: token, code: refused }, 'an ACP session’s code was refused')
        return null
    }
  }

  /**
   * The cart's codes set to exactly the asked ones, whatever their case: the others removed, then the missing ones
   * added in the asked order, each as the calling agent. A refusal the agent can act on answers; any other stops there
   * and is reported as `codesDown`.
   */
  async function setCodes(
    token: string,
    asked: AskedCodes,
    caller: Caller,
  ): Promise<{ answer: ResponseEnvelope } | { codesDown: boolean }> {
    const held = cartCodes((await deps.cart(token))?.promotions).codes.map((c) => c.code)
    const wanted = new Set(asked.codes.map((c) => c.code.toLowerCase()))
    const has = new Set(held.map((code) => code.toLowerCase()))
    for (const code of held) {
      if (wanted.has(code.toLowerCase())) continue
      const result = await mcp.call('cart_removeCode', { cart: token, code }, caller)
      if (result.isError !== true) continue
      const answer = codeRefusal(result, asked, asked.param, token)
      return answer === null ? { codesDown: true } : { answer }
    }
    for (const { code, index } of asked.codes) {
      if (has.has(code.toLowerCase())) continue
      const result = await mcp.call('cart_addCode', { cart: token, code }, caller)
      if (result.isError !== true) continue
      const answer = codeRefusal(result, asked, `${asked.param}[${index}]`, token)
      return answer === null ? { codesDown: true } : { answer }
    }
    return { codesDown: false }
  }

  // --- Routes ----------------------------------------------------------------------------------------------------

  async function create(request: AgentRouteRequest, agent: string): Promise<ResponseEnvelope> {
    const body = parsed(createRequest, request.body)
    if (!body.ok) return body.answer
    const { data } = body
    if (data.currency.toLowerCase() !== deps.store.currency.toLowerCase()) {
      return invalid(`This store sells in ${deps.store.currency.toLowerCase()}`, '$.currency')
    }
    const codes = askedCodes(data)
    if (!codes.ok) return codes.answer
    const lines = mergeItems(data.line_items)
    const caller = callerOf(request, agent)
    return keyed('acp.create', request, agent, async () => {
      const refused = await check(lines, caller)
      if (refused !== null) return refused
      const opened = await mcp.call('cart_get', {}, caller)
      const token = opened.structuredContent?.['cartHandle']
      if (opened.isError === true || typeof token !== 'string') {
        throw new Error('the cart route opened no cart for an ACP session')
      }
      const failed = await setLines(token, new Map(), lines, caller)
      if (failed !== null) {
        // Left empty and unreferenced, to expire.
        await mcp.call('cart_clear', { cart: token }, caller)
        return failed
      }
      await save(token, {
        ...(data.buyer !== undefined && { buyer: data.buyer }),
        ...(data.fulfillment_details !== undefined && {
          fulfillment_details: data.fulfillment_details,
        }),
      })
      if (codes.asked === undefined) return answer(token, 201, { write: true })
      const set = await setCodes(token, codes.asked, caller)
      if ('answer' in set) {
        await mcp.call('cart_clear', { cart: token }, caller)
        return set.answer
      }
      return answer(token, 201, { write: true, codesDown: set.codesDown })
    })
  }

  async function read(request: AgentRouteRequest): Promise<ResponseEnvelope> {
    return answer(request.params['id'] ?? '', 200)
  }

  async function update(request: AgentRouteRequest, agent: string): Promise<ResponseEnvelope> {
    const id = request.params['id'] ?? ''
    const body = parsed(updateRequest, request.body)
    if (!body.ok) return body.answer
    const { data } = body
    if (data.line_items !== undefined && data.line_items.length === 0) {
      return invalid('A session holds at least one item', '$.line_items')
    }
    const codes = askedCodes(data)
    if (!codes.ok) return codes.answer
    const caller = callerOf(request, agent)
    const lines = data.line_items === undefined ? undefined : mergeItems(data.line_items)
    return keyed('acp.update', request, agent, async () => {
      const loaded = await load(id)
      if (loaded === null) return notFound(id)
      if (loaded.status !== 'ready_for_payment' && loaded.status !== 'not_ready_for_payment') {
        return closed()
      }
      const { stored } = loaded
      const details =
        data.fulfillment_details === undefined
          ? stored.fulfillment_details
          : { ...stored.fulfillment_details, ...data.fulfillment_details }
      // Checked against the address this update leaves, before anything changes.
      const selected = data.selected_fulfillment_options ?? []
      const offered = selected.length === 0 ? [] : await offeredIds(id, details)
      const other =
        offered === null ? -1 : selected.findIndex((option) => !offered.includes(option.option_id))
      if (offered !== null && other >= 0) {
        return invalid(
          offered.length === 0
            ? 'No fulfillment option is offered until the session has an address the store delivers to'
            : `The fulfillment options for this address are ${offered.join(', ')}`,
          `$.selected_fulfillment_options[${other}].option_id`,
        )
      }
      if (lines !== undefined) {
        const refused =
          (await check(lines, caller)) ?? (await replaceLines(id, loaded.cart, lines, caller))
        if (refused !== null) return refused
      }
      await save(id, {
        ...stored,
        ...(data.buyer !== undefined && { buyer: { ...stored.buyer, ...data.buyer } }),
        ...(details !== undefined && { fulfillment_details: details }),
        ...(data.selected_fulfillment_options !== undefined && {
          selected_fulfillment_options: data.selected_fulfillment_options,
        }),
      })
      if (codes.asked === undefined) return answer(id, 200, { write: true })
      const set = await setCodes(id, codes.asked, caller)
      if ('answer' in set) return set.answer
      return answer(id, 200, { write: true, codesDown: set.codesDown })
    })
  }

  async function cancel(request: AgentRouteRequest, agent: string): Promise<ResponseEnvelope> {
    const id = request.params['id'] ?? ''
    const body = parsed(cancelRequest, request.body)
    if (!body.ok) return body.answer
    return keyed('acp.cancel', request, agent, async () => {
      const loaded = await load(id)
      if (loaded === null) return notFound(id)
      // A session with an order (paid, or being paid) is never cancelled here: the order is the merchant's.
      if (loaded.status !== 'ready_for_payment' && loaded.status !== 'not_ready_for_payment') {
        return closed()
      }
      await mcp.call('cart_clear', { cart: id }, callerOf(request, agent))
      await save(id, { ...loaded.stored, canceledAt: new Date().toISOString() })
      return answer(id, 200)
    })
  }

  async function complete(request: AgentRouteRequest, agent: string): Promise<ResponseEnvelope> {
    const id = request.params['id'] ?? ''
    const body = parsed(completeRequest, request.body)
    if (!body.ok) return body.answer
    const payment = body.data.payment_data
    if (payment.handler_id !== ACP_HANDLER_ID) {
      return invalid(`The only payment handler is ${ACP_HANDLER_ID}`, '$.payment_data.handler_id')
    }
    const credential = payment.instrument?.credential
    if (credential?.type !== ACP_CREDENTIAL) {
      return invalid(
        `The ${ACP_HANDLER_ID} handler takes an ${ACP_CREDENTIAL} credential`,
        '$.payment_data.instrument.credential.type',
      )
    }
    return keyed('acp.complete', request, agent, async () => {
      const loaded = await load(id)
      if (loaded === null) return notFound(id)
      if (loaded.status === 'completed' || loaded.status === 'canceled') return closed()
      if (loaded.status === 'complete_in_progress') return inFlight()
      const { buyer, fulfillment_details: details } = loaded.stored
      if (buyer === undefined || details?.address === undefined) {
        const first = missingMessages(loaded.stored)[0]!
        return invalid('The session is not ready for payment', first.param!)
      }
      const shippingAddress = toNymbalAddress(details.address, details.phone_number)
      const { quoted } = loaded.stored
      let result: BeginCheckoutResult
      try {
        result = await deps.checkout.beginCheckout({
          cartToken: id,
          email: buyer.email,
          shippingAddress,
          billingAddress:
            payment.billing_address === undefined
              ? shippingAddress
              : toNymbalAddress(payment.billing_address),
          // The total and option the agent was last answered: anything else is refused and answered re-priced.
          ...(quoted !== undefined && {
            expectedTotalMinor: quoted.totalMinor,
            shippingOptionId: quoted.optionId,
          }),
          delegatedPayment: { token: credential.token },
        })
      } catch (err) {
        return refusedCheckout(id, err)
      }
      if (result.payment.status === 'succeeded') {
        return answer(id, 200, result.orderKey === undefined ? {} : { orderKey: result.orderKey })
      }
      if (result.payment.status === 'failed') {
        return declined(
          id,
          result.payment.reason === 'payment_requires_action'
            ? message(
                'requires_3ds',
                'The card asked for an authentication no one was present to give.',
              )
            : message('payment_declined', 'The payment was declined.'),
        )
      }
      return answer(id, 200)
    })
  }

  /** The session again with why its payment did not go through, unless something else now holds it. */
  async function declined(id: string, why: AcpMessage): Promise<ResponseEnvelope> {
    const loaded = await load(id)
    if (loaded === null) return notFound(id)
    const open = loaded.status === 'ready_for_payment' || loaded.status === 'not_ready_for_payment'
    return { status: 200, body: await render(loaded, open ? { messages: [why] } : {}) }
  }

  async function refusedCheckout(id: string, err: unknown): Promise<ResponseEnvelope> {
    if (err instanceof PaymentError) {
      return declined(id, message('payment_declined', 'The payment was declined.'))
    }
    if (err instanceof NotFoundError) return notFound(id)
    if (!(err instanceof CheckoutError)) throw err
    switch (err.code) {
      case 'checkout.in_progress':
        return inFlight()
      case 'checkout.payment_in_progress':
        return answer(id, 200)
      case 'checkout.cart_empty': {
        // A concurrent complete converted the cart first.
        const loaded = await load(id)
        if (loaded === null) return notFound(id)
        if (loaded.status === 'completed') return closed()
        return invalid('The session holds no items', '$.line_items')
      }
      case 'checkout.out_of_stock':
      case 'checkout.reservation_failed':
      case 'checkout.variant_missing': {
        const loaded = await load(id)
        if (loaded === null) return notFound(id)
        return {
          status: 200,
          body: await render(loaded, {
            status: 'not_ready_for_payment',
            messages: [message('out_of_stock', 'An item is no longer in stock.', '$.line_items')],
          }),
        }
      }
      case 'checkout.total_changed':
      case 'checkout.shipping_option_unavailable':
        return answer(id, 200, { write: true, priceChanged: true })
      case 'checkout.tax_unavailable':
      case 'checkout.promotions_unavailable':
      case 'checkout.shipping_unavailable':
      case 'checkout.no_shipping':
        // Priced again, the session carries the refusal's message; were the engine back, it is ready to retry.
        return answer(id, 200, { write: true })
      default:
        throw err
    }
  }

  /** A POST once per Idempotency-Key, scoped to the endpoint and the ACP key; the key with another body is ACP's 422. */
  async function keyed(
    command: string,
    request: AgentRouteRequest,
    keyName: string,
    run: () => Promise<ResponseEnvelope>,
  ): Promise<ResponseEnvelope> {
    const key = `acp:${sha256(header(request, 'idempotency-key') ?? '').toString('hex')}`
    const hash = requestHash({ params: request.params, body: request.body })
    const result = await deps.idempotent(command, { key, hash, keyName }, run)
    const code = (result.body as { error?: { code?: unknown } } | undefined)?.error?.code
    if (result.status === 409 && code === 'idempotency.key_reused') {
      return acpError(
        422,
        'idempotency_conflict',
        'This Idempotency-Key was already used with a different request',
      )
    }
    return result
  }

  async function feed(request: AgentRouteRequest, agent: string): Promise<ResponseEnvelope> {
    const caller = callerOf(request, agent)
    const urls = deps.urls()
    const seller = { name: deps.store.name, links: config.links.map((link) => ({ ...link })) }
    const products: Record<string, unknown>[] = []
    let cursor: string | undefined
    do {
      const page = await mcp.call(
        'products_list',
        { limit: String(FEED_PAGE), ...(cursor !== undefined && { cursor }) },
        caller,
      )
      if (page.isError === true) throw new Error('the catalogue refused the ACP feed’s read')
      const { items, nextCursor } = (page.structuredContent ?? {}) as {
        items?: ListedProduct[]
        nextCursor?: string | null
      }
      for (const listed of items ?? []) {
        const mapped = ucpProduct(listed, urls)
        if (mapped === null) continue
        products.push({
          id: mapped.id,
          title: mapped.title,
          ...(mapped.url !== undefined && { url: mapped.url }),
          media: mapped.media ?? [],
          variants: listed.variants.map((variant) => ({
            id: variant.id,
            title: variant.name,
            price: { amount: variant.priceMinor, currency: listed.currency },
            availability: {
              available: variant.stock > 0,
              status: variant.stock > 0 ? 'in_stock' : 'out_of_stock',
            },
            ...barcodesOf(variant.gtin),
            seller,
          })),
        })
      }
      cursor = typeof nextCursor === 'string' && nextCursor !== '' ? nextCursor : undefined
    } while (cursor !== undefined)
    return { status: 200, body: { products } }
  }

  /** Each route behind the checks, echoing Request-Id and (on a POST) Idempotency-Key on whatever it answers. */
  function route(
    method: 'GET' | 'POST',
    path: string,
    handle: (request: AgentRouteRequest, agent: string) => Promise<ResponseEnvelope>,
  ): AgentRoute {
    const post = method === 'POST'
    return {
      method,
      path: `${ACP_BASE_PATH}${path}`,
      async handle(request) {
        const requestId = header(request, 'request-id')
        const key = post ? header(request, 'idempotency-key') : undefined
        const echo = {
          ...(requestId !== undefined && { 'request-id': requestId }),
          ...(key !== undefined && { 'idempotency-key': key }),
        }
        let result: ResponseEnvelope
        try {
          const agent = keyOf(request)
          result =
            agent === null
              ? acpError(401, 'unauthorized', 'The bearer is not this store’s ACP key')
              : (refusal(request, post) ?? (await handle(request, agent)))
        } catch (err) {
          deps.logger.error({ err, path }, 'an ACP request failed')
          result = acpError(500, 'processing_error', 'The store could not answer this request')
        }
        return { ...result, headers: { ...result.headers, ...echo } }
      },
    }
  }

  return {
    name: 'acp',
    capabilities: { ...ACP_CAPABILITIES },
    routes: [
      route('POST', '/checkout_sessions', create),
      route('GET', '/checkout_sessions/:id', read),
      route('POST', '/checkout_sessions/:id', update),
      route('POST', '/checkout_sessions/:id/complete', complete),
      route('POST', '/checkout_sessions/:id/cancel', cancel),
      route('GET', '/feed', feed),
    ],
  }
}
