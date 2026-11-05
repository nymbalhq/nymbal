import { createHash, timingSafeEqual } from 'node:crypto'
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
  type DocumentStoreAdapter,
  type Logger,
  type Order,
  type ResponseEnvelope,
  type ToolSurface,
} from '@nymbalhq/types'
import { requestHash } from '../../audit/idempotency.js'
import type { BeginCheckoutResult, CheckoutService } from '../../services/checkout-service.js'
import { ucpProduct, type ListedProduct } from '../catalog.js'
import { toNymbalAddress } from './address.js'
import { acpAgentName } from './agent-name.js'
import {
  ACP_BASE_PATH,
  ACP_CAPABILITIES,
  ACP_CREDENTIAL,
  ACP_HANDLER_ID,
  ACP_SESSIONS,
  ACP_VERSION,
  acpHandler,
} from './constants.js'
import {
  acpSession,
  cartLines,
  missingMessages,
  orderLines,
  STANDARD_FULFILLMENT,
  type AcpMessage,
  type AcpOrder,
  type AcpStatus,
  type StoredSession,
} from './session.js'

export interface AcpLink {
  type: string
  url: string
  title?: string | undefined
}

/** Runs a POST once per Idempotency-Key: its stored answer is replayed, and the key with another body is refused. */
export type AcpIdempotent = (
  command: string,
  request: { key: string; hash: string },
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
  checkout: Pick<CheckoutService, 'beginCheckout'>
  idempotent: AcpIdempotent
  payments: { providerName: string; environment: 'test' | 'production' }
  urls: () => AgentSurfaceUrls
  config: { apiKey: string; links: readonly AcpLink[]; merchantId?: string | undefined }
  store: { currency: string; name: string }
  logger: Logger
}

/** The most distinct items one session holds. */
const MAX_ITEMS = 50
/** The feed reads the catalogue a page at a time. */
const FEED_PAGE = 100
const SUPPORTED_VERSIONS = [ACP_VERSION]
const MAX_IDEMPOTENCY_KEY = 255

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

const createRequest = z
  .object({
    line_items: z.array(item).min(1),
    currency: z.string().min(1),
    capabilities: z.record(z.string(), z.unknown()),
    buyer: buyer.optional(),
    fulfillment_details: fulfillmentDetails.optional(),
    fulfillment_groups: ignored,
    affiliate_attribution: ignored,
    coupons: ignored,
    discounts: ignored,
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
    coupons: ignored,
    discounts: ignored,
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

/** What a refused cart call answers, by the cart route's code. */
const CART_REFUSAL: Record<string, string> = {
  'cart.variant_missing': 'invalid_item_id',
  'cart.qty_limit': 'quantity_exceeded',
}

/**
 * The Agentic Commerce Protocol's checkout over REST (`/api/acp/**`): a session is a guest cart, opened and changed
 * through the route tools as the calling agent, and completed by charging the agent's delegated payment through the
 * store's checkout. Every request is held to the store's ACP key, the pinned API version and, on a POST, an
 * Idempotency-Key, in that order, before anything is read.
 */
export function createAcpSurface(deps: AcpSurfaceDeps): AgentSurfaceAdapter {
  const { mcp, config } = deps
  const storeKey = sha256(config.apiKey)
  const handler = () =>
    acpHandler({
      psp: deps.payments.providerName,
      environment: deps.payments.environment,
      merchantId: config.merchantId,
    })

  function callerOf(request: AgentRouteRequest): Caller {
    return { agent: { name: acpAgentName(header(request, 'user-agent')) }, ip: request.ip }
  }

  /** The bearer (in constant time), the version and, on a POST, the key: the first that fails answers. */
  function refusal(request: AgentRouteRequest, post: boolean): ResponseEnvelope | null {
    const authorization = header(request, 'authorization') ?? ''
    const bearer = /^Bearer (.+)$/i.exec(authorization)?.[1] ?? ''
    if (bearer === '' || !timingSafeEqual(sha256(bearer), storeKey)) {
      return acpError(401, 'unauthorized', 'The bearer is not this store’s ACP key')
    }
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

  function render(
    loaded: Loaded,
    opts: { messages?: AcpMessage[]; status?: AcpStatus; orderKey?: string } = {},
  ): Record<string, unknown> {
    const common = {
      stored: loaded.stored,
      links: config.links,
      handler: handler(),
    }
    if (loaded.status === 'completed') {
      const { order } = loaded
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
      })
    }
    const { cart } = loaded
    const lines =
      loaded.status === 'complete_in_progress' ? orderLines(loaded.order) : cartLines(cart)
    const missing =
      loaded.status === 'ready_for_payment' || loaded.status === 'not_ready_for_payment'
        ? missingMessages(loaded.stored)
        : []
    return acpSession({
      ...common,
      id: loaded.token,
      status: opts.status ?? loaded.status,
      lines,
      currency: cart.currency,
      expiresAt: cart.expiresAt,
      messages: [...missing, ...(opts.messages ?? [])],
    })
  }

  async function answer(
    token: string,
    status: number,
    opts?: Parameters<typeof render>[1],
  ): Promise<ResponseEnvelope> {
    const loaded = await load(token)
    if (loaded === null) return notFound(token)
    return { status, body: render(loaded, opts) }
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

  // --- Routes ----------------------------------------------------------------------------------------------------

  async function create(request: AgentRouteRequest): Promise<ResponseEnvelope> {
    const body = parsed(createRequest, request.body)
    if (!body.ok) return body.answer
    const { data } = body
    if (data.currency.toLowerCase() !== deps.store.currency.toLowerCase()) {
      return invalid(`This store sells in ${deps.store.currency.toLowerCase()}`, '$.currency')
    }
    const lines = mergeItems(data.line_items)
    const caller = callerOf(request)
    return keyed('acp.create', request, async () => {
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
      return answer(token, 201)
    })
  }

  async function read(request: AgentRouteRequest): Promise<ResponseEnvelope> {
    return answer(request.params['id'] ?? '', 200)
  }

  async function update(request: AgentRouteRequest): Promise<ResponseEnvelope> {
    const id = request.params['id'] ?? ''
    const body = parsed(updateRequest, request.body)
    if (!body.ok) return body.answer
    const { data } = body
    if (data.line_items !== undefined && data.line_items.length === 0) {
      return invalid('A session holds at least one item', '$.line_items')
    }
    const other = (data.selected_fulfillment_options ?? []).findIndex(
      (option) => option.option_id !== STANDARD_FULFILLMENT,
    )
    if (other >= 0) {
      return invalid(
        `The only fulfillment option is ${STANDARD_FULFILLMENT}`,
        `$.selected_fulfillment_options[${other}].option_id`,
      )
    }
    const caller = callerOf(request)
    const lines = data.line_items === undefined ? undefined : mergeItems(data.line_items)
    return keyed('acp.update', request, async () => {
      const loaded = await load(id)
      if (loaded === null) return notFound(id)
      if (loaded.status !== 'ready_for_payment' && loaded.status !== 'not_ready_for_payment') {
        return closed()
      }
      if (lines !== undefined) {
        const refused =
          (await check(lines, caller)) ?? (await replaceLines(id, loaded.cart, lines, caller))
        if (refused !== null) return refused
      }
      const { stored } = loaded
      await save(id, {
        ...stored,
        ...(data.buyer !== undefined && { buyer: { ...stored.buyer, ...data.buyer } }),
        ...(data.fulfillment_details !== undefined && {
          fulfillment_details: { ...stored.fulfillment_details, ...data.fulfillment_details },
        }),
        ...(data.selected_fulfillment_options !== undefined && {
          selected_fulfillment_options: data.selected_fulfillment_options,
        }),
      })
      return answer(id, 200)
    })
  }

  async function cancel(request: AgentRouteRequest): Promise<ResponseEnvelope> {
    const id = request.params['id'] ?? ''
    const body = parsed(cancelRequest, request.body)
    if (!body.ok) return body.answer
    return keyed('acp.cancel', request, async () => {
      const loaded = await load(id)
      if (loaded === null) return notFound(id)
      // A session with an order (paid, or being paid) is never cancelled here: the order is the merchant's.
      if (loaded.status !== 'ready_for_payment' && loaded.status !== 'not_ready_for_payment') {
        return closed()
      }
      await mcp.call('cart_clear', { cart: id }, callerOf(request))
      await save(id, { ...loaded.stored, canceledAt: new Date().toISOString() })
      return answer(id, 200)
    })
  }

  async function complete(request: AgentRouteRequest): Promise<ResponseEnvelope> {
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
    return keyed('acp.complete', request, async () => {
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
    return { status: 200, body: render(loaded, open ? { messages: [why] } : {}) }
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
          body: render(loaded, {
            status: 'not_ready_for_payment',
            messages: [message('out_of_stock', 'An item is no longer in stock.', '$.line_items')],
          }),
        }
      }
      default:
        throw err
    }
  }

  /** A POST once per Idempotency-Key, scoped to the endpoint; the key with another body is ACP's 422. */
  async function keyed(
    command: string,
    request: AgentRouteRequest,
    run: () => Promise<ResponseEnvelope>,
  ): Promise<ResponseEnvelope> {
    const key = `acp:${sha256(header(request, 'idempotency-key') ?? '').toString('hex')}`
    const hash = requestHash({ params: request.params, body: request.body })
    const result = await deps.idempotent(command, { key, hash }, run)
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

  async function feed(request: AgentRouteRequest): Promise<ResponseEnvelope> {
    const caller = callerOf(request)
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
    handle: (request: AgentRouteRequest) => Promise<ResponseEnvelope>,
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
          result = refusal(request, post) ?? (await handle(request))
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
