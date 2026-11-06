import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { PaymentError, type PaymentIntentParams, type PaymentsAdapter } from '@nymbalhq/types'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLogger } from '../../src/logger.js'
import { serveWithAgents, type AgentStore } from './agents.js'
import { createKernel, type Kernel } from './kernel.js'

// An ACP agent over HTTP against a kernel served with its agent surfaces, `agents.acp` on: the store's key as a bearer,
// the pinned API-Version, a fresh Idempotency-Key on every POST unless the test names one, and the pinned ACP
// shapes (tests/fixtures/acp). Beside it, a payments adapter that records what the checkout asks of it.

export const ACP_PATH = '/api/acp'
export const PINNED_VERSION = '2026-04-17'
/** The store's ACP key: at least 32 characters. */
export const ACP_KEY = 'acp-acceptance-key-0123456789abcdefghij'
export const ACP_LINKS = [
  { type: 'terms_of_use', url: 'https://shop.example/terms', title: 'Terms of use' },
  { type: 'return_policy', url: 'https://shop.example/returns' },
] as const
/** What an agent's client sends unless the test says otherwise: its first product token names the agent. */
export const AGENT_UA = 'ChatGPT/2.0 (acceptance; +https://openai.com/bot)'
export const AGENT_SOURCE = 'agent:chatgpt'

/** The kernel config with `agents.acp` on under the test key, and its own rule high enough for a suite's requests. */
export function withAcp(
  config: NymbalConfig,
  acp: Record<string, unknown> = {},
  rate: { requests: number; window: string; action: 'block' } = {
    requests: 100_000,
    window: '1m',
    action: 'block',
  },
): NymbalConfig {
  return {
    ...config,
    security: {
      ...config.security,
      rateLimit: { ...config.security.rateLimit, '/api/acp/**': rate },
    },
    agents: {
      ...config.agents,
      acp: { enabled: true, apiKey: ACP_KEY, links: [...ACP_LINKS], ...acp },
    },
  } as NymbalConfig
}

/** A kernel on SQLite with ACP on (reshaped further by `configure`), served as `nymbal dev` serves it. */
export async function acpStore(
  opts: {
    configure?: (config: NymbalConfig) => NymbalConfig
    payments?: PaymentsAdapter
  } = {},
): Promise<AgentStore> {
  const kernel: Kernel = await createKernel({
    dialect: 'sqlite',
    configure: (config) => {
      const on = withAcp(config)
      const shaped = opts.configure === undefined ? on : opts.configure(on)
      return opts.payments === undefined
        ? shaped
        : { ...shaped, commerce: { ...shaped.commerce, payments: { provider: 'custom' } } }
    },
    ...(opts.payments !== undefined && { appOptions: { adapters: { payments: opts.payments } } }),
  })
  return serveWithAgents(kernel)
}

export interface AcpAnswer<T = Record<string, unknown>> {
  status: number
  body: T
  headers: Headers
}

/** Headers to send; a `null` value leaves that header out. */
export type AcpHeaders = Record<string, string | null>

export interface AcpClient {
  request<T = AcpSession>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: AcpHeaders,
  ): Promise<AcpAnswer<T>>
  create(body: unknown, headers?: AcpHeaders): Promise<AcpAnswer<AcpSession>>
  get(id: string, headers?: AcpHeaders): Promise<AcpAnswer<AcpSession>>
  update(id: string, body: unknown, headers?: AcpHeaders): Promise<AcpAnswer<AcpSession>>
  complete(id: string, body: unknown, headers?: AcpHeaders): Promise<AcpAnswer<AcpSession>>
  cancel(id: string, headers?: AcpHeaders): Promise<AcpAnswer<AcpSession>>
  feed(headers?: AcpHeaders): Promise<AcpAnswer<{ products: FeedProduct[] }>>
}

/** An agent holding `key` (the store's by default), as its client sends each request. */
export function acpClient(
  baseUrl: string,
  opts: { key?: string; userAgent?: string } = {},
): AcpClient {
  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: AcpHeaders = {},
  ): Promise<AcpAnswer<T>> {
    const sent: Record<string, string | null> = {
      accept: 'application/json',
      authorization: `Bearer ${opts.key ?? ACP_KEY}`,
      'api-version': PINNED_VERSION,
      'user-agent': opts.userAgent ?? AGENT_UA,
      ...(method === 'POST' && {
        'content-type': 'application/json',
        'idempotency-key': `acp-${randomUUID()}`,
      }),
    }
    for (const [name, value] of Object.entries(headers)) sent[name.toLowerCase()] = value
    const res = await fetch(new URL(`${ACP_PATH}${path}`, baseUrl), {
      method,
      headers: Object.fromEntries(
        Object.entries(sent).filter((entry): entry is [string, string] => entry[1] !== null),
      ),
      ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
    })
    const text = await res.text()
    let parsed: unknown = {}
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new Error(`${method} ${ACP_PATH}${path} answered ${res.status} with no JSON: ${text}`)
    }
    return { status: res.status, body: parsed as T, headers: res.headers }
  }
  return {
    request,
    create: (body, headers) => request('POST', '/checkout_sessions', body, headers),
    get: (id, headers) => request('GET', `/checkout_sessions/${id}`, undefined, headers),
    update: (id, body, headers) => request('POST', `/checkout_sessions/${id}`, body, headers),
    complete: (id, body, headers) =>
      request('POST', `/checkout_sessions/${id}/complete`, body, headers),
    cancel: (id, headers) => request('POST', `/checkout_sessions/${id}/cancel`, {}, headers),
    feed: (headers) => request('GET', '/feed', undefined, headers),
  }
}

// --- The pinned shapes, as far as the suites read them ---------------------------------------------------------

export interface AcpTotal {
  type: string
  display_text: string
  amount: number
}

export interface AcpLineItem {
  id: string
  item: { id: string }
  quantity: number
  name?: string
  unit_amount?: number
  totals: AcpTotal[]
}

export interface AcpMessage {
  type: string
  code?: string
  param?: string
  content_type?: string
  content?: string
}

export interface AcpOrder {
  type?: string
  id: string
  order_number?: string
  checkout_session_id: string
  permalink_url: string
  status?: string
}

export interface AcpSession {
  id: string
  status: string
  currency: string
  line_items: AcpLineItem[]
  totals: AcpTotal[]
  fulfillment_options: unknown[]
  messages: AcpMessage[]
  links: unknown[]
  capabilities: { payment?: { handlers?: Array<Record<string, unknown>> } }
  expires_at?: string
  buyer?: Record<string, unknown>
  fulfillment_details?: Record<string, unknown>
  order?: AcpOrder
  // An Error answer's fields, when the answer is one.
  type?: string
  code?: string
  message?: string
  param?: string
  supported_versions?: string[]
}

export interface FeedVariant {
  id: string
  title: string
  price?: { amount: number; currency: string }
  availability?: { available?: boolean; status?: string }
}

export interface FeedProduct {
  id: string
  title?: string
  variants: FeedVariant[]
}

export const CHECKOUT_SESSION = 'schema.agentic_checkout.json#/$defs/CheckoutSession'
export const WITH_ORDER = 'schema.agentic_checkout.json#/$defs/CheckoutSessionWithOrder'
export const ACP_ERROR = 'schema.agentic_checkout.json#/$defs/Error'
export const PRODUCTS_RESPONSE = 'schema.feed.json#/$defs/ProductsResponse'

// --- Requests ----------------------------------------------------------------------------------------------------

export interface Line {
  variantId: string
  quantity: number
}

export const ACP_ADDRESS = {
  name: 'Ada Byron Lovelace',
  line_one: '12 Analytical Row',
  line_two: 'Flat 3',
  city: 'London',
  state: 'Greater London',
  country: 'GB',
  postal_code: 'EC1A 1BB',
} as const

export function fulfillmentDetails(phone = '+447700900123') {
  return { name: ACP_ADDRESS.name, phone_number: phone, address: { ...ACP_ADDRESS } }
}

export function buyerEmail(tag = 'buyer', trigger = ''): string {
  return `acp-${tag}-${randomUUID().slice(0, 8)}${trigger}@acp.test`
}

/**
 * A create body: the lines as `{ id, quantity }`, the store's currency, and (unless left out) a buyer and fulfillment
 * details. Without `quantity` it validates as the pinned CheckoutSessionCreateRequest; the suite's own typo would
 * otherwise read as the store's refusal.
 */
export function createBody(
  lines: readonly Line[],
  opts: { email?: string | null; fulfillment?: boolean; currency?: string } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    line_items: lines.map((l) => ({ id: l.variantId, quantity: l.quantity })),
    currency: opts.currency ?? 'gbp',
    capabilities: {},
    ...(opts.email !== null && { buyer: { email: opts.email ?? buyerEmail() } }),
    ...(opts.fulfillment !== false && { fulfillment_details: fulfillmentDetails() }),
  }
  const strict = {
    ...body,
    line_items: lines.map((l) => ({ id: l.variantId })),
  }
  const errors = validateAcp(
    'schema.agentic_checkout.json#/$defs/CheckoutSessionCreateRequest',
    strict,
  )
  if (errors.length > 0)
    throw new Error(`the suite's create body is not ACP's: ${errors.join('; ')}`)
  return body
}

/** `payment_data` for the tokenized-card handler carrying a Shared Payment Token. */
export function sptPayment(
  token = 'spt_x',
  over: { handler_id?: string; credentialType?: string } = {},
) {
  return {
    payment_data: {
      handler_id: over.handler_id ?? 'card_tokenized',
      instrument: { type: 'card', credential: { type: over.credentialType ?? 'spt', token } },
    },
  }
}

// --- Reading what a session left -----------------------------------------------------------------------------------

/** A line set as sorted `(id, quantity)` pairs, the form two line sets are compared in. */
export function pairs(
  lines: ReadonlyArray<{ id: string; quantity: number }>,
): Array<[string, number]> {
  return lines
    .map((l): [string, number] => [l.id, l.quantity])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

export function sessionPairs(session: AcpSession): Array<[string, number]> {
  return pairs(session.line_items.map((l) => ({ id: l.item.id, quantity: l.quantity })))
}

export function requestPairs(lines: readonly Line[]): Array<[string, number]> {
  const summed = new Map<string, number>()
  for (const l of lines) summed.set(l.variantId, (summed.get(l.variantId) ?? 0) + l.quantity)
  return pairs([...summed].map(([id, quantity]) => ({ id, quantity })))
}

export interface ApiCart {
  token: string
  items: Array<{ variantId: string; qty: number; priceMinor: number }>
  subtotalMinor: number
  currency: string
  expiresAt: string
}

/** `GET /api/cart` as the browser holding the session's cart cookie reads it. */
export async function cartOverHttp(baseUrl: string, token: string): Promise<ApiCart> {
  const res = await fetch(new URL('/api/cart', baseUrl), {
    headers: { accept: 'application/json', cookie: `nymbal.cart=${token}` },
  })
  const body = (await res.json()) as { data?: ApiCart }
  if (res.status !== 200 || body.data === undefined)
    throw new Error(`GET /api/cart: ${res.status} ${JSON.stringify(body)}`)
  return body.data
}

export function cartPairs(cart: ApiCart): Array<[string, number]> {
  return pairs(cart.items.map((i) => ({ id: i.variantId, quantity: i.qty })))
}

export function totalOf(session: AcpSession, type: string): number | undefined {
  return session.totals.find((t) => t.type === type)?.amount
}

/** The session's error messages as `code @ param`, sorted. */
export function errorMessages(session: AcpSession): string[] {
  return (session.messages ?? [])
    .filter((m) => m.type === 'error')
    .map((m) => `${m.code ?? ''} @ ${m.param ?? ''}`)
    .sort()
}

/** Orders placed from one cart, by status, as committed. */
export function ordersOfCart(file: string, token: string): Array<{ id: string; status: string }> {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return db
      .prepare('SELECT id, status FROM orders WHERE cart_token = ? ORDER BY created_at')
      .all(token) as Array<{ id: string; status: string }>
  } finally {
    db.close()
  }
}

/**
 * Sets a variant's stock in the command store behind the read model's back, as a concurrent order taking it would
 * between ACP's check and its cart call.
 */
export function takeStockBehindReadModel(file: string, variantId: string, stock: number): void {
  const db = new Database(file)
  try {
    db.pragma('busy_timeout = 5000')
    db.prepare('UPDATE variants SET stock = ? WHERE id = ?').run(stock, variantId)
  } finally {
    db.close()
  }
}

// --- Payments that record what the checkout asks ---------------------------------------------------------------

export interface RecordingPayments {
  adapter: PaymentsAdapter
  /** Every createPaymentIntent's params, and the id of the intent it answered (none when it threw). */
  intents: Array<{ params: PaymentIntentParams & { delegatedToken?: string }; intentId?: string }>
  cancels: string[]
  /** The next createPaymentIntent throws Stripe's decline as the adapter wraps it, once. */
  declineNext(): void
}

/** The native stub's behaviour (the receipt email picks the outcome), every intent and cancel recorded. */
export function recordingPayments(): RecordingPayments {
  const stub = createNativeStubPaymentsAdapter({
    logger: createLogger({ pretty: false, level: 'error' }),
  })
  const intents: RecordingPayments['intents'] = []
  const cancels: string[] = []
  let decline = false
  const adapter: PaymentsAdapter = {
    ...stub,
    async createPaymentIntent(params) {
      const entry: RecordingPayments['intents'][number] = { params: { ...params } }
      intents.push(entry)
      if (decline) {
        decline = false
        throw new PaymentError('intent_failed', 'Your card was declined.')
      }
      const intent = await stub.createPaymentIntent(params)
      entry.intentId = intent.id
      return intent
    },
    async cancelPaymentIntent(intentId) {
      cancels.push(intentId)
      return stub.cancelPaymentIntent(intentId)
    },
  }
  return {
    adapter,
    intents,
    cancels,
    declineNext() {
      decline = true
    },
  }
}

/** Reads until the catalogue listing serves every slug: the ACP checks read the read model. */
export async function untilListed(baseUrl: string, slugs: readonly string[]): Promise<void> {
  await vi.waitFor(
    async () => {
      const missing: string[] = []
      for (const slug of slugs) {
        const res = await fetch(new URL(`/api/products/${slug}`, baseUrl))
        await res.arrayBuffer()
        if (res.status !== 200) missing.push(slug)
      }
      if (missing.length > 0) throw new Error(`not served yet: ${missing.join(', ')}`)
    },
    { timeout: 20_000, interval: 50 },
  )
}

export interface PoolVariant {
  slug: string
  productName: string
  variantName: string
  variantId: string
  priceMinor: number
  stock: number
}

/** One active product per entry with one variant each, served by the read side before this returns. */
export async function seedPool(
  store: AgentStore,
  entries: ReadonlyArray<{ priceMinor: number; stock: number }>,
): Promise<PoolVariant[]> {
  const pool: PoolVariant[] = []
  for (const [i, e] of entries.entries()) {
    const tag = randomUUID().slice(0, 8)
    const productName = `ACP Lamp ${tag}`
    const variantName = `Size ${i + 1}`
    const product = await store.kernel.services.product.create({
      slug: `acp-${tag}`,
      name: productName,
      description: 'A lamp an agent buys.',
      status: 'active',
      variants: [
        {
          sku: `ACP-${tag}`,
          name: variantName,
          priceMinor: e.priceMinor,
          stock: e.stock,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    pool.push({
      slug: product.slug,
      productName,
      variantName,
      variantId: product.variants[0]!.id,
      priceMinor: e.priceMinor,
      stock: e.stock,
    })
  }
  await untilListed(
    store.baseUrl,
    pool.map((p) => p.slug),
  )
  return pool
}
