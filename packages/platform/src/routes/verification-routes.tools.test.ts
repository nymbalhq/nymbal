import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Caller, ToolDefinition } from '@nymbalhq/types'
import { createKernel, type Kernel } from '../../tests/support/kernel.js'
import { AGENT, listedNames, toolSurface } from '../../tests/support/mcp.js'
import { toolsOf } from '../mcp/registry.js'
import { RouteTable, recordingAdapter } from '../mcp/route-table.js'
import { routeSchemas } from './schemas.js'

// The sign-up confirmation routes: the shopper's own (following the mailed link, asking for it again) are served and
// are no tool an agent can call; support's (send the link again, mark the address confirmed, the mail health read) are
// served and never in a shopper's tool list. The route table is filled the way attachHttp fills the app's own.

const SHOPPER_ROUTES = ['POST /api/auth/verify-email', 'POST /api/auth/resend-verification']
const ADMIN_ROUTES = [
  'POST /api/admin/customers/:id/send-verification',
  'POST /api/admin/customers/:id/mark-verified',
  'GET /api/admin/mail-health',
]

let kernel: Kernel
let table: RouteTable
let tools: ToolDefinition[]

beforeAll(async () => {
  kernel = await createKernel({ dialect: 'sqlite' })
  table = new RouteTable()
  const nothing = {
    registerRoute() {},
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  await kernel.app.attachHttp(recordingAdapter(table, nothing), { adminRoot: null })
  tools = toolsOf(table)
}, 30_000)

afterAll(async () => {
  await kernel?.close()
})

const keyOf = (tool: ToolDefinition) => `${tool.route.method} ${tool.route.path}`

describe('AC-10: the confirmation routes are kept from agents and shoppers', () => {
  // Defect: an agent can follow a link or ask for one again for any address.
  it('AC-10: verify-email and resend-verification are registered, each marked tool: false, and neither is in the agent tool list', () => {
    const served = SHOPPER_ROUTES.filter((key) => table.keys().includes(key))
    const asTools = tools.map(keyOf).filter((key) => SHOPPER_ROUTES.includes(key))

    expect(served).toEqual(SHOPPER_ROUTES)
    expect(asTools).toEqual([])
    expect(served.map((key) => routeSchemas[key]?.tool)).toEqual(served.map(() => false))
  })

  // Defect: a signed-in shopper's agent can mail any customer a link or confirm an address.
  it('AC-10: the three admin routes are registered, and a customer’s tool list holds none of them while an admin’s holds every one that is a tool', async () => {
    const { customer } = await kernel.services.auth.register({
      email: `tools-${Date.now()}@verify.test`,
      password: 'tools-correct-horse',
    })
    const shopper: Caller = {
      auth: { userId: customer.id, roles: ['customer'], token: 'not-checked' },
      agent: AGENT,
    }
    const admin: Caller = {
      auth: { userId: 'tools-admin', roles: ['admin'], token: 'not-checked' },
      agent: AGENT,
    }
    const adminToolNames = tools
      .filter((tool) => ADMIN_ROUTES.includes(keyOf(tool)))
      .map((tool) => tool.name)
      .sort()

    const served = ADMIN_ROUTES.filter((key) => table.keys().includes(key))
    const surface = toolSurface(kernel.app)
    const shopperList = await listedNames(surface, shopper)
    const adminList = await listedNames(surface, admin)

    expect(served).toEqual(ADMIN_ROUTES)
    expect(shopperList.filter((name) => adminToolNames.includes(name))).toEqual([])
    expect(adminList.filter((name) => adminToolNames.includes(name)).sort()).toEqual(adminToolNames)
  })
})
