import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_PRODUCT_CREATED,
  type HttpAdapter,
  type NymbalEvent,
  type ProductCreatedV1Payload,
  type RouteHandler,
  type VariantOption,
} from '@nymbalhq/types'
import { registerProductProjection } from '../../src/handlers/projections/product-projection.js'
import { createLogger } from '../../src/logger.js'
import { registerProductRoutes } from '../../src/routes/products.js'
import { createTestEnv } from './setup.js'

// P2-12 AC-5 (the read model): every product reads back from GET /api/products/:slug with `variants[].options` as
// `VariantOption[]`, whether it was created now with an array or projected from an older row whose variant options
// are a JSON string. The projection builds from the rows at handle time (P3-02 decision 1), so the older shape is a
// second product, created alike, whose variant rows are then rewritten to hold the options stringified, and whose own
// product.created.v1 is delivered again; the two differ only in that shape. Kills: a projection that copies `options`
// through as `unknown`, leaving a string in the read model for the storefronts to parse.

type Env = Awaited<ReturnType<typeof createTestEnv>>

interface ServedProduct {
  variants: Array<{ sku: string; options: unknown }>
}

let env: Env
let invoke: (slug: string) => Promise<{ status: number; body: unknown }>
const created: Array<NymbalEvent<ProductCreatedV1Payload>> = []

function routes() {
  const handlers = new Map<string, RouteHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      handlers.set(`${method}:${path}`, handler)
    },
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  return { adapter, handlers }
}

beforeAll(async () => {
  env = await createTestEnv()
  const logger = createLogger({ pretty: false, level: 'error' })
  await registerProductProjection({
    eventBus: env.eventBus,
    documentStore: env.documentStore,
    logger,
    storeId: 'test',
    currency: 'GBP',
    repos: env.repos,
  })
  await env.eventBus.subscribe(EVT_PRODUCT_CREATED, (event) => {
    created.push(event as NymbalEvent<ProductCreatedV1Payload>)
  })
  const { adapter, handlers } = routes()
  registerProductRoutes(adapter, env.documentStore, 'test')
  const get = handlers.get('GET:/api/products/:slug')!
  invoke = async (slug) => {
    const res = await get({
      method: 'GET',
      path: `/api/products/${slug}`,
      url: `http://localhost/api/products/${slug}`,
      params: { slug },
      query: {},
      body: null,
      rawBody: undefined,
      headers: {},
      cookies: {},
      requestId: 'p2-12-req',
      correlationId: 'p2-12-corr',
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      },
      ip: '127.0.0.1',
    } as Parameters<RouteHandler>[0])
    return { status: res.status, body: res.body }
  }
}, 60_000)

afterAll(async () => {
  await env?.commandStore.close()
})

async function served(slug: string): Promise<ServedProduct> {
  const res = await invoke(slug)
  expect(res.status, `GET /api/products/${slug}`).toBe(200)
  return (res.body as { data: ServedProduct }).data
}

/** Each variant's options, by SKU, so the order the read model keeps variants in does not matter. */
const optionsBySku = (product: ServedProduct) =>
  Object.fromEntries(product.variants.map((v) => [v.sku, v.options]))

const arbVariantOptions: fc.Arbitrary<VariantOption[][]> = fc.array(
  fc.uniqueArray(
    fc.record({
      name: fc.constantFrom('Size', 'Colour', 'Material'),
      value: fc.stringMatching(/^[A-Za-z0-9 ]{1,10}$/),
    }),
    { minLength: 1, maxLength: 3, selector: (o) => o.name },
  ),
  { minLength: 1, maxLength: 4 },
)

describe('P2-12: one option shape in the read model', () => {
  it('AC-5: a product created with VariantOption[] and one projected from an older row with JSON-string options both read back from GET /api/products/:slug as VariantOption[]', async () => {
    await fc.assert(
      fc.asyncProperty(arbVariantOptions, async (variantOptions) => {
        const tag = randomUUID().slice(0, 8)
        const create = (slug: string, sku: (i: number) => string) =>
          env.product.create({
            slug,
            name: `Option Shape ${tag}`,
            description: '',
            status: 'active',
            type: 'variable',
            variants: variantOptions.map((options, i) => ({
              sku: sku(i),
              name: `Variant ${i}`,
              priceMinor: 1000 + i,
              stock: 3,
              options,
            })),
          })
        const newSku = (i: number) => `P212-${tag}-${i}`
        const oldSku = (i: number) => `P212-${tag}-old-${i}`
        const product = await create(`p2-12-new-${tag}`, newSku)
        const older = await create(`p2-12-old-${tag}`, oldSku)
        await new Promise((r) => setImmediate(r))

        // The older product as an older row holds it: every variant's options a JSON string.
        const variants = await env.commandStore.read((tx) =>
          env.repos.variant.findByProduct(tx, older.id),
        )
        await env.commandStore.transaction(async (tx) => {
          for (const v of variants) {
            await env.repos.variant.update(tx, v.id, {
              options: JSON.stringify(v.options) as unknown as VariantOption[],
              updatedAt: new Date(),
            })
          }
        })
        const stored = await env.commandStore.read((tx) =>
          env.repos.variant.findByProduct(tx, older.id),
        )
        expect(
          stored.map((v) => typeof v.options),
          'the older rows hold their options as a string',
        ).toEqual(variants.map(() => 'string'))

        const event = created.find((e) => e.payload.product.id === older.id)
        expect(event, 'the product.created.v1 the older product published').not.toBeUndefined()
        await env.eventBus.publish<ProductCreatedV1Payload>({ ...event!, id: randomUUID() })
        await new Promise((r) => setImmediate(r))

        const want = (sku: (i: number) => string) =>
          Object.fromEntries(variantOptions.map((options, i) => [sku(i), options]))
        expect(optionsBySku(await served(product.slug))).toEqual(want(newSku))
        expect(optionsBySku(await served(older.slug))).toEqual(want(oldSku))
      }),
      { numRuns: 25 },
    )
  })
})
