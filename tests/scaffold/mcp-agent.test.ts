import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// AC-11, run by scripts/scaffold-clean.sh in the `scaffold-clean` project once it has scaffolded `shop`, written
// `agents: { mcp: { writes: 'apply' } }` into its config and started `nymbal dev`. An agent, as the seeded admin, adds
// a product and places an order through the published packages alone: once through `nymbal mcp` on stdio, once
// straight to the store's `POST /api/mcp`.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory
//   NYMBAL_API_URL       the API its `nymbal dev` serves

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const API_URL_SET = process.env['NYMBAL_API_URL']
if (!SCAFFOLD_DIR || !API_URL_SET) {
  throw new Error(
    'AC-11 needs NYMBAL_SCAFFOLD_DIR (the scaffolded project) and NYMBAL_API_URL (its running API). ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which scaffolds, starts `nymbal dev` and sets both.',
  )
}
const DIR: string = SCAFFOLD_DIR
const API_URL: string = API_URL_SET
const ENDPOINT = new URL('/api/mcp', API_URL).href

/** The proof's bound: an agent's whole journey, connect to the order read. */
const BUDGET_SECONDS = 300
const STOCK = 5
const QTY = 2

const AGENT = { name: 'scaffold-agent', version: '1.0.0' }
const address = {
  firstName: 'Agent',
  lastName: 'Buyer',
  addressLine1: '1 Protocol Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

function dotEnvValue(source: string, key: string): string {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(source)
  const value = match?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
  if (value === undefined) throw new Error(`${key} is not in ${DIR}/.env`)
  return value
}

/** The admin create-app wrote to the project's `.env`, which the first `nymbal dev` seeded. */
function seededAdmin(): { email: string; password: string } {
  const env = readFileSync(join(DIR, '.env'), 'utf8')
  return {
    email: dotEnvValue(env, 'NYMBAL_ADMIN_EMAIL'),
    password: dotEnvValue(env, 'NYMBAL_ADMIN_PASSWORD'),
  }
}

/** An access token for the admin, signed in through the store's CSRF pair as any API client signs in. */
async function adminToken(): Promise<string> {
  const csrf = randomBytes(32).toString('hex')
  const res = await fetch(new URL('/api/auth/login', API_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `nymbal.csrf=${csrf}`,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify(seededAdmin()),
  })
  const body = (await res.json()) as { data?: { accessToken?: string } }
  if (res.status !== 200 || body.data?.accessToken === undefined) {
    throw new Error(`admin login: ${res.status} ${JSON.stringify(body)}`)
  }
  return body.data.accessToken
}

type Structured = Record<string, unknown>

async function call(client: Client, name: string, args: Structured) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true) throw new Error(`${name}: ${JSON.stringify(result.content)}`)
  return result as typeof result & { structuredContent?: Structured & { cartHandle?: string } }
}

interface Journey {
  seconds: number
  stockBefore: number
  stockAfter: number
  orderLines: Array<{ variantId: string; qty: number }>
  variantId: string
  listed: boolean
}

/** Connect, create a product of one variant at STOCK, publish it, find it listed, cart QTY, check out, read the order. */
async function journey(
  transport: StdioClientTransport | StreamableHTTPClientTransport,
): Promise<Journey> {
  const started = performance.now()
  const client = new Client(AGENT)
  await client.connect(transport)
  try {
    const tag = randomBytes(6).toString('hex')
    const slug = `agent-proof-${tag}`
    const created = await call(client, 'admin_products_create', {
      slug,
      name: `Agent Proof ${tag}`,
      variants: [
        { sku: `AGENT-${tag}`, name: 'Default', priceMinor: 1200, stock: STOCK, options: [] },
      ],
    })
    const productId = created.structuredContent?.['id'] as string
    const variants = created.structuredContent?.['variants'] as Array<{ id: string; stock: number }>
    const variantId = variants[0]!.id
    await call(client, 'admin_products_publish', { id: productId })

    // The listing is a projection: read until it holds the published product, bounded.
    const listed = await vi.waitFor(
      async () => {
        const page = await call(client, 'products_list', { limit: '100' })
        const items = (page.structuredContent?.['items'] ?? []) as Array<{ slug: string }>
        if (!items.some((item) => item.slug === slug)) throw new Error(`${slug} not listed yet`)
        return true
      },
      { timeout: 30_000, interval: 250 },
    )

    const cart = (await call(client, 'cart_get', {})).structuredContent?.cartHandle
    await call(client, 'cart_addItem', { cart, variantId, qty: QTY })
    const placed = await call(client, 'checkout_begin', {
      cart,
      email: `agent-${tag}@nymbal.dev`,
      billingAddress: address,
      shippingAddress: address,
    })
    const order = await call(client, 'admin_orders_get', {
      orderNumber: placed.structuredContent?.['orderNumber'],
    })
    const seconds = (performance.now() - started) / 1000

    const after = await call(client, 'admin_products_get', { id: productId })
    const stockAfter = (
      after.structuredContent?.['variants'] as Array<{ id: string; stock: number }>
    ).find((v) => v.id === variantId)!.stock
    const lineItems = (order.structuredContent?.['lineItems'] ?? []) as Array<{
      variantId: string
      qty: number
    }>
    return {
      seconds,
      stockBefore: variants[0]!.stock,
      stockAfter,
      orderLines: lineItems.map(({ variantId: id, qty }) => ({ variantId: id, qty })),
      variantId,
      listed,
    }
  } finally {
    await client.close()
  }
}

describe('AC-11: an agent adds a product and places an order against a fresh scaffold', () => {
  it(
    `AC-11: through nymbal mcp as the seeded admin, the agent creates a product of stock ${STOCK}, publishes it, sees it listed, carts ${QTY}, places the order and reads it with that line, stock falling by ${QTY}, inside ${BUDGET_SECONDS} s`,
    async () => {
      const admin = seededAdmin()
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !entry[0].startsWith('npm_') &&
            !entry[0].startsWith('VITEST'),
        ),
      )
      const run = await journey(
        new StdioClientTransport({
          command: join(DIR, 'node_modules', '.bin', 'nymbal'),
          args: ['mcp'],
          cwd: DIR,
          env: {
            ...env,
            NYMBAL_MCP_URL: ENDPOINT,
            NYMBAL_MCP_EMAIL: admin.email,
            NYMBAL_MCP_PASSWORD: admin.password,
          },
          stderr: 'pipe',
        }),
      )
      const proof = `mcp-proof: ${Math.ceil(run.seconds)}s`
      // eslint-disable-next-line no-console
      console.log(proof)
      writeFileSync(join(DIR, '..', 'mcp-proof'), `${proof}\n`)

      expect(run.listed).toBe(true)
      expect(run.orderLines).toEqual([{ variantId: run.variantId, qty: QTY }])
      expect(run.stockBefore).toBe(STOCK)
      expect(run.stockAfter).toBe(run.stockBefore - QTY)
      expect(run.seconds).toBeLessThan(BUDGET_SECONDS)
    },
    (BUDGET_SECONDS + 60) * 1000,
  )

  it(
    `AC-11: the same journey straight to POST /api/mcp with the admin's bearer, no bridge, places the order and moves stock by ${QTY}`,
    async () => {
      const token = await adminToken()
      const run = await journey(
        new StreamableHTTPClientTransport(new URL(ENDPOINT), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      )

      expect(run.orderLines).toEqual([{ variantId: run.variantId, qty: QTY }])
      expect(run.stockAfter).toBe(run.stockBefore - QTY)
      expect(run.seconds).toBeLessThan(BUDGET_SECONDS)
    },
    (BUDGET_SECONDS + 60) * 1000,
  )
})
