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
import { UCP_VERSION, ucpProfile } from './profile.js'

// AC-2: the business profile `/.well-known/ucp` serves, against the published UCP 2026-08-25 schema. AC-3: the UCP
// tool surface `attachHttp` builds beside the route tools, and the agent name a UCP call travels under.

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
