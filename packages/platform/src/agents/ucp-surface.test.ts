import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSurfaceAdapter, Caller, ToolDefinition } from '@nymbalhq/types'
import { validateUcp } from '../../../../tests/fixtures/ucp/validate.js'
import { routeSchemas } from '../routes/schemas.js'
import { toolName } from '../mcp/registry.js'
import { createKernel } from '../../tests/support/kernel.js'
import { serveKernel, type ServedKernel } from '../../tests/support/http.js'
import { ANONYMOUS, adminAccount, customerAccount, toolSurface } from '../../tests/support/mcp.js'
import { agentNameOf } from './agent-name.js'
import { ucpProduct, type ListedProduct } from './catalog.js'
import { UCP_VERSION, ucpProfile } from './profile.js'

// AC-2: the business profile `/.well-known/ucp` serves, against the published UCP 2026-08-25 schema. AC-3: the UCP
// tool surface `attachHttp` builds beside the route tools, and the agent name a UCP call travels under. AC-6: a listed
// product's brand and its variants' GTINs in UCP's product shape, absent (never empty) when the store holds none.

const SHOPPING = 'dev.ucp.shopping'
const CAPABILITIES = [
  'dev.ucp.shopping.catalog.lookup',
  'dev.ucp.shopping.catalog.search',
  'dev.ucp.shopping.checkout',
]
const SCHEMAS = 'https://ucp.dev/2026-08-25/schemas/'

/** The five tools of the UCP MCP binding this store offers, and the argument each requires. */
const UCP_TOOLS: Record<string, string> = {
  search_catalog: 'catalog',
  lookup_catalog: 'catalog',
  get_product: 'catalog',
  create_checkout: 'checkout',
  get_checkout: 'id',
}

const origin = fc
  .record({
    scheme: fc.constantFrom('http', 'https'),
    host: fc.oneof(fc.domain(), fc.constant('localhost'), fc.constant('127.0.0.1')),
    port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  })
  .map(
    ({ scheme, host, port }) =>
      new URL(`${scheme}://${host}${port === undefined ? '' : `:${port}`}`).origin,
  )

describe('AC-2: the UCP business profile', () => {
  it('AC-2: property: for any API and storefront origins the profile validates as a business profile of UCP 2026-08-25, its one shopping service is MCP at <api>/api/ucp/mcp, its capabilities are exactly search, lookup and checkout on ucp.dev schemas, and it names no payment handler', () => {
    fc.assert(
      fc.property(origin, fc.option(origin, { nil: undefined }), (api, storefront) => {
        const profile = ucpProfile({ api, storefront }) as {
          ucp: {
            version: string
            services: Record<string, Array<{ transport: string; endpoint: string }>>
            capabilities: Record<string, Array<{ schema: string }>>
            payment_handlers: unknown
          }
        }

        expect(validateUcp('profile.json#/$defs/business_schema', profile)).toEqual([])
        expect([UCP_VERSION, profile.ucp.version]).toEqual(['2026-08-25', '2026-08-25'])
        expect(profile.ucp.services[SHOPPING]).toEqual([
          expect.objectContaining({ transport: 'mcp', endpoint: `${api}/api/ucp/mcp` }),
        ])
        expect(Object.keys(profile.ucp.capabilities).sort()).toEqual(CAPABILITIES)
        for (const entries of Object.values(profile.ucp.capabilities)) {
          for (const entry of entries)
            expect(entry.schema.startsWith(SCHEMAS), entry.schema).toBe(true)
        }
        expect(profile.ucp.payment_handlers).toEqual({})
      }),
    )
  })
})

describe('AC-3: the UCP tool surface', () => {
  let served: ServedKernel
  let callers: Record<'anonymous' | 'customer' | 'admin', Caller>

  beforeAll(async () => {
    const kernel = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(kernel)
    callers = {
      anonymous: ANONYMOUS,
      customer: (await customerAccount(kernel, served.baseUrl)).caller,
      admin: (await adminAccount(kernel, served.baseUrl)).caller,
    }
  }, 30_000)

  afterAll(async () => {
    await served?.stop()
  })

  function ucpSurface(): AgentSurfaceAdapter {
    const surface = served.kernel.app.agents?.surfaces.find((s: AgentSurfaceAdapter) => s.name === 'ucp')
    if (surface?.endpoint === undefined)
      throw new Error('attachHttp built no ucp agent surface with an endpoint')
    return surface
  }

  async function listed(
    list: (caller: Caller) => ToolDefinition[] | Promise<ToolDefinition[]>,
    caller: Caller,
  ) {
    return Promise.resolve(list(caller))
  }

  it('AC-3: the UCP surface lists exactly the five tools for an anonymous, a customer and an admin caller, each public, each requiring its catalog, checkout or id argument and none requiring meta', async () => {
    const tools = ucpSurface().endpoint!.tools

    for (const [who, caller] of Object.entries(callers)) {
      const definitions = await listed((c) => tools.list(c), caller)

      expect(definitions.map((tool) => tool.name).sort(), who).toEqual(
        Object.keys(UCP_TOOLS).sort(),
      )
      for (const tool of definitions) {
        const required = ((tool.inputSchema as { required?: string[] }).required ?? []).slice()
        expect(tool.scope, `${who} ${tool.name}`).toBe('public')
        expect(required, `${who} ${tool.name}`).toContain(UCP_TOOLS[tool.name])
        expect(required, `${who} ${tool.name}`).not.toContain('meta')
      }
    }
  })

  it("AC-3: for every caller the /api/mcp listing holds only the route registry's tools and none of the UCP surface's, and the UCP surface lists none of the route tools", async () => {
    const routeTools = new Set(Object.values(routeSchemas).map((entry) => toolName(entry.name)))
    const ucp = ucpSurface().endpoint!.tools
    const mcp = toolSurface(served.kernel.app)

    for (const [who, caller] of Object.entries(callers)) {
      const mcpNames = (await listed((c) => mcp.list(c), caller)).map((tool) => tool.name)
      const ucpNames = (await listed((c) => ucp.list(c), caller)).map((tool) => tool.name)

      expect(
        mcpNames.filter((name) => !routeTools.has(name)),
        who,
      ).toEqual([])
      expect(
        mcpNames.filter((name) => ucpNames.includes(name)),
        who,
      ).toEqual([])
      expect(
        ucpNames.filter((name) => routeTools.has(name)),
        who,
      ).toEqual([])
      expect(mcpNames.length, who).toBeGreaterThan(ucpNames.length)
    }
  })

  it("AC-3: property: agentNameOf answers the profile URL's host, else the MCP client's name, else mcp-client, and never throws on a malformed meta", () => {
    const clientInfo = fc.oneof(
      fc.constant(undefined),
      fc.record({ name: fc.string({ minLength: 1 }), version: fc.string() }),
      fc.anything(),
    )
    const expectedClient = (info: unknown): string => {
      const name = (info as { name?: unknown } | null | undefined)?.name
      return typeof info === 'object' && info !== null && typeof name === 'string' && name !== ''
        ? name
        : 'mcp-client'
    }

    fc.assert(
      fc.property(fc.domain(), clientInfo, (host, info) => {
        const meta = { 'ucp-agent': { profile: `https://${host}/.well-known/ucp` } }
        expect(agentNameOf(meta, info)).toBe(new URL(`https://${host}`).host)
      }),
    )

    const notAUrl = fc.string().filter((s) => {
      try {
        return new URL(s).host === ''
      } catch {
        return true
      }
    })
    const malformed = fc.oneof(
      fc.anything(),
      fc.record({ 'ucp-agent': fc.anything() }),
      fc.record({ 'ucp-agent': fc.record({ profile: fc.oneof(notAUrl, fc.anything()) }) }),
    )
    fc.assert(
      fc.property(malformed, clientInfo, (meta, info) => {
        const profile = (meta as { 'ucp-agent'?: { profile?: unknown } } | null)?.['ucp-agent']
          ?.profile
        fc.pre(
          !(typeof profile === 'string' && URL.canParse(profile) && new URL(profile).host !== ''),
        )
        expect(agentNameOf(meta, info)).toBe(expectedClient(info))
      }),
    )
  })
})

describe('AC-6: brand and GTIN in the UCP product', () => {
  const URLS = { api: 'https://api.shop.test', storefront: 'https://shop.test' }
  const GTINS = ['96385074', '036000291452', '4006381333931', '9780306406157', '00012345600012']
  /** No GTIN to serve: null, the key absent, or empty. */
  const NO_GTIN = [null, undefined, ''] as const
  /** No brand to serve: the key absent, empty, or whitespace. */
  const NO_BRAND = [undefined, '', '   ', '\t'] as const

  const gtinArb = fc.oneof(fc.constantFrom(...GTINS), fc.constantFrom(...NO_GTIN))
  const brandArb = fc.oneof(
    fc.stringMatching(/^[A-Za-z][A-Za-z &'.-]{0,30}[A-Za-z.]$/),
    fc.constantFrom(...NO_BRAND),
  )

  const listedArb = fc
    .record({
      slug: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
      name: fc.stringMatching(/^[A-Z][a-z]{1,12}$/),
      brand: brandArb,
      variants: fc.array(
        fc.record({
          id: fc.uuid(),
          sku: fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,4}$/),
          name: fc.stringMatching(/^[A-Z][a-z]{1,8}$/),
          priceMinor: fc.integer({ min: 0, max: 100_000 }),
          stock: fc.nat({ max: 20 }),
          gtin: gtinArb,
        }),
        { minLength: 1, maxLength: 4 },
      ),
    })
    .map(({ brand, variants, ...rest }) => listed({ ...rest, brand, variants }))

  type Gtin = string | null | undefined
  function listed(over: {
    slug?: string
    name?: string
    brand?: string | undefined
    variants: Array<{
      id: string
      sku: string
      name: string
      priceMinor: number
      stock: number
      gtin: Gtin
    }>
  }): ListedProduct {
    const prices = over.variants.map((v) => v.priceMinor)
    return {
      id: `id-${over.slug ?? 'lamp'}`,
      slug: over.slug ?? 'lamp',
      name: over.name ?? 'Lamp',
      description: '',
      shortDescription: 'A lamp.',
      media: [],
      priceRange: { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) },
      currency: 'GBP',
      ...(over.brand !== undefined && { brand: over.brand }),
      variants: over.variants.map(({ gtin, ...v }) => ({
        ...v,
        ...(gtin !== undefined && { gtin }),
      })),
    }
  }

  const variant = (id: string, gtin: Gtin) => ({
    id,
    sku: `SKU-${id}`,
    name: `V ${id}`,
    priceMinor: 1000,
    stock: 2,
    gtin,
  })

  it("AC-6: a variant with a GTIN maps to barcodes [{ type: 'GTIN', value }] and one with a null, absent or empty gtin has no barcodes key; the product itself never has one", () => {
    for (const none of NO_GTIN) {
      const mapped = ucpProduct(
        listed({ variants: [variant('a', GTINS[2]), variant('b', none)] }),
        URLS,
      )
      const variants = (mapped?.variants ?? []) as unknown as Array<Record<string, unknown>>
      expect(
        variants.map((v) => [v['id'], 'barcodes' in v, v['barcodes']]),
        JSON.stringify(none),
      ).toEqual([
        ['a', true, [{ type: 'GTIN', value: GTINS[2] }]],
        ['b', false, undefined],
      ])
      expect('barcodes' in (mapped as object), 'barcodes on the product').toBe(false)
    }
  })

  it('AC-6: a product with a brand maps to metadata { brand }, and one whose brand is absent, empty or whitespace has no metadata key', () => {
    const branded = ucpProduct(
      listed({ brand: 'Acme Lighting', variants: [variant('a', null)] }),
      URLS,
    ) as unknown as Record<string, unknown>
    expect(branded['metadata']).toEqual({ brand: 'Acme Lighting' })
    for (const none of NO_BRAND) {
      const mapped = ucpProduct(
        listed({ brand: none, variants: [variant('a', null)] }),
        URLS,
      ) as unknown as Record<string, unknown>
      expect(['metadata' in mapped, mapped['metadata']], JSON.stringify(none)).toEqual([
        false,
        undefined,
      ])
    }
  })

  it('AC-6: property: over generated listed products, the mapped product validates against UCP product.json, metadata is { brand } exactly when the brand is not blank, and each variant carries barcodes exactly when its gtin is set, holding that gtin', () => {
    fc.assert(
      fc.property(listedArb, (product) => {
        const mapped = ucpProduct(product, URLS) as unknown as Record<string, unknown> & {
          variants: Array<Record<string, unknown>>
        }
        expect(validateUcp('shopping/types/product.json', mapped)).toEqual([])
        const brand = (product as { brand?: string }).brand
        expect(mapped['metadata']).toEqual(
          brand !== undefined && brand.trim() !== '' ? { brand } : undefined,
        )
        expect('metadata' in mapped).toBe(brand !== undefined && brand.trim() !== '')
        expect(mapped.variants.map((v) => ['barcodes' in v, v['barcodes']])).toEqual(
          product.variants.map((v) => {
            const gtin = (v as { gtin?: string | null }).gtin
            return typeof gtin === 'string' && gtin !== ''
              ? [true, [{ type: 'GTIN', value: gtin }]]
              : [false, undefined]
          }),
        )
      }),
      { numRuns: 200 },
    )
  })
})
