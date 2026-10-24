import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P3-02 AC-6 (spec P3-02-replay-engine): the journeys hold through a rebuild. Run mid-suite (the other journeys of the
// run go on around it, fullyParallel), this journey makes a product and a pending order of its own, reads what the
// storefront API serves for them, runs the built `nymbal replay` against the run's own store (the store variables
// scripts/e2e-server.mjs gave the API, from NYMBAL_E2E_STORE_ENV_FILE), reads again, and walks the pages. On a shared
// document store (redis, as the nightly postgres-redis set has it, or postgres-jsonb) it rebuilds every read model
// (`--to all`); on the default in-memory store, where the read model lives in the API's process and replay refuses
// all but search (decision 6), it rebuilds search. Every API read after equals the read before, and the product page
// and the search page show what the API serves after. Kills: a rebuild that changes what a shopper sees (a document
// rebuilt differently from the live one, an index that loses the product, an order read model that loses the order).

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const CLI = join(REPO, 'packages', 'cli', 'bin', 'nymbal.mjs')
const STORE_VARIABLES = [
  'NYMBAL_COMMAND_STORE',
  'NYMBAL_DOCUMENT_STORE',
  'NYMBAL_EVENT_BUS',
  'NYMBAL_SQLITE_PATH',
  'DATABASE_URL',
  'REDIS_URL',
  'NYMBAL_REDIS_PREFIX',
]

/** The store variables the API server was started with, as scripts/e2e-server.mjs recorded them. */
function serverStoreEnv(): Record<string, string> {
  const file = process.env.NYMBAL_E2E_STORE_ENV_FILE
  if (file === undefined || file === '') {
    throw new Error('NYMBAL_E2E_STORE_ENV_FILE is not set: tests/e2e/playwright.config.ts sets it')
  }
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist: scripts/e2e-server.mjs writes the API's store variables there`,
    )
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
}

async function replay(to: string): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of [...STORE_VARIABLES, 'LOG_LEVEL']) delete env[name]
  Object.assign(env, serverStoreEnv())
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [CLI, 'replay', '--to', to],
      { cwd: REPO, env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    )
    return { code: 0, out: stdout + stderr }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}${typeof e.code === 'number' ? '' : e.message}`,
    }
  }
}

async function data<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`)
  expect(res.status(), `GET ${path}`).toBe(200)
  return ((await res.json()) as { data: T }).data
}

interface Served {
  slug: string
  name: string
  currency?: string
  variants: Array<{ id: string; priceMinor: number; stock: number }>
}

/** The product-card slugs rendered inside `nymbal-search-results`, through the cards' own shadow roots, in order. */
function slugsInResults(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const host = document.querySelector('nymbal-search-results')
    if (!host?.shadowRoot) return null
    const ids: string[] = []
    const walk = (root: ParentNode): void => {
      for (const node of root.querySelectorAll('*')) {
        const id = node.getAttribute('data-testid')
        if (id?.startsWith('product-card-')) ids.push(id.slice('product-card-'.length))
        if (node.shadowRoot) walk(node.shadowRoot)
      }
    }
    walk(host.shadowRoot)
    return ids
  })
}

test.describe('Through a rebuild @rebuild', () => {
  test('AC-6: nymbal replay run mid-suite against this run’s store leaves what the storefront API serves for a product and an order of the test’s own unchanged, and the product and search pages show what it then serves', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 6)
    const added = await request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(request),
      data: { variantId: product.variantId, qty: 1 },
    })
    expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
    const placed = await request.post(`${API_URL}/api/checkout`, {
      headers: await csrf(request),
      data: {
        email: `p3-02-${Date.now()}+stub-pending@nymbal.dev`,
        billingAddress: ADDRESS,
        shippingAddress: ADDRESS,
      },
    })
    expect(placed.ok(), `POST /api/checkout: ${await placed.text()}`).toBe(true)
    const { orderNumber } = ((await placed.json()) as { data: { orderNumber: string } }).data
    const query = encodeURIComponent(product.name)

    const reads = async () => ({
      product: await data<Served>(request, `/api/products/${product.slug}`),
      search: (
        await data<{ items: Array<{ slug: string }> }>(request, `/api/products/search?q=${query}`)
      ).items.map((p) => p.slug),
      listed: (
        await data<{ items: Array<{ slug: string }> }>(request, '/api/products?limit=100')
      ).items.find((p) => p.slug === product.slug),
      order: await data<{ orderNumber: string; status: string }>(
        request,
        `/api/orders/${orderNumber}`,
      ),
    })
    const before = await reads()
    expect(before.search, 'the index finds the product before the rebuild').toContain(product.slug)

    const shared = (serverStoreEnv()['NYMBAL_DOCUMENT_STORE'] ?? 'in-memory') !== 'in-memory'
    const run = await replay(shared ? 'all' : 'search')
    expect(run.code, run.out).toBe(0)

    expect(before, 'what the API serves, after the rebuild').toEqual(await reads())
    const after = await reads()

    await page.goto(`/product/${product.slug}`)
    await expect(page.getByTestId('product-title')).toHaveText(after.product.name, {
      timeout: 15_000,
    })
    const price = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: after.product.currency ?? 'GBP',
    }).format(after.product.variants[0]!.priceMinor / 100)
    await expect(page.getByTestId('product-price')).toHaveText(price)

    await page.goto(`/search?q=${query}`)
    await expect.poll(() => slugsInResults(page), { timeout: 15_000 }).toEqual(after.search)
  })
})

const ADDRESS = {
  firstName: 'Rae',
  lastName: 'Builder',
  addressLine1: '7 Replay Row',
  city: 'Leeds',
  region: 'West Yorkshire',
  postalCode: 'LS1 4AP',
  country: 'GB',
}
