import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import { address, createKernel, seedVariant, type Seeded } from '../support/kernel.js'

// POST /api/checkout/quote on a store served as `nymbal dev` serves it (SQLite) with the built-in quote rule, 30 a
// minute per (address, cart): through the HTTP route, and through the `checkout_quote` tool on /api/mcp, which is
// admitted under its route's rule. A request the limiter lets through with an empty body answers 400 (the route's
// input validation), so a 429 is the limiter's. How the buckets count is proven in the http package.

const REQUESTS = 30
const QUOTE = '/api/checkout/quote'
const CART_COOKIE = 'nymbal.cart'

/** The kernel config with the built-in quote rule (the harness raises it) and CSRF off: the limiter alone. */
function builtInQuote(config: NymbalConfig): NymbalConfig {
  const rateLimit = { ...config.security.rateLimit }
  delete rateLimit[QUOTE]
  return nymbalConfigSchema.parse({
    ...config,
    security: { ...config.security, csrf: false, rateLimit },
  })
}

let store: AgentStore
let seeded: Seeded

beforeAll(async () => {
  store = await serveWithAgents(await createKernel({ dialect: 'sqlite', configure: builtInQuote }))
  seeded = await seedVariant(store.kernel, 1_000, { priceMinor: 1_200 })
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

interface Answer {
  status: number
  code: string | undefined
  retryAfter: number
}

async function quoteAs(cart: string, forwardedFor: string): Promise<Answer> {
  const res = await fetch(`${store.baseUrl}${QUOTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor,
      cookie: `${CART_COOKIE}=${cart}`,
    },
    body: '{}',
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
  return {
    status: res.status,
    code: body.error?.code,
    retryAfter: Number(res.headers.get('retry-after') ?? 0),
  }
}

describe('AC-13: the quote route is limited as checkout is', () => {
  // Kills: the quote route left without a rule (the anchored /api/checkout pattern does not reach it), so one client
  // drives the tax, promotions and carrier engines without bound.
  it('AC-13: from one address, a cart’s 31st POST /api/checkout/quote in a minute answers 429 rate_limit.block with a Retry-After of at most 60 s, while another cart’s first is still answered by the route', async () => {
    const client = '198.18.7.1'

    const cartA: Answer[] = []
    for (let i = 0; i <= REQUESTS; i += 1) cartA.push(await quoteAs('quote-cart-a', client))
    const cartB = await quoteAs('quote-cart-b', client)

    expect(cartA.slice(0, REQUESTS).map((a) => a.status)).toEqual(
      Array.from({ length: REQUESTS }, () => 400),
    )
    expect(cartA[REQUESTS]).toMatchObject({ status: 429, code: 'rate_limit.block' })
    expect(cartA[REQUESTS]!.retryAfter).toBeGreaterThanOrEqual(1)
    expect(cartA[REQUESTS]!.retryAfter).toBeLessThanOrEqual(60)
    expect(cartB).toMatchObject({ status: 400, code: 'validation.failed' })
  })

  // Kills: an agent on /api/mcp quoting without bound, its tool calls counted under no rule but /api/mcp's 120.
  it('AC-13: checkout_quote calls on /api/mcp count under the quote rule: the 31st in a minute is an isError result rate.limited, where the thirty before quoted', async () => {
    const mcp = new Client(
      { name: 'quote-limit-bot', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    )
    await mcp.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', store.baseUrl)))
    try {
      const added = await mcp.callTool({
        name: 'cart_addItem',
        arguments: { variantId: seeded.variantId, qty: 1 },
      })
      const cart = (added.structuredContent as { cartHandle?: unknown } | undefined)?.cartHandle

      const results: Array<{ isError: boolean; code: unknown }> = []
      for (let i = 0; i <= REQUESTS; i += 1) {
        const result = await mcp.callTool({
          name: 'checkout_quote',
          arguments: { cart, shippingAddress: address },
        })
        const structured = (result.structuredContent ?? {}) as Record<string, unknown>
        results.push({ isError: result.isError ?? false, code: structured['code'] })
      }

      expect(results.slice(0, REQUESTS)).toEqual(
        Array.from({ length: REQUESTS }, () => ({ isError: false, code: undefined })),
      )
      expect(results[REQUESTS]).toEqual({ isError: true, code: 'rate.limited' })
    } finally {
      await mcp.close()
    }
  }, 30_000)
})
