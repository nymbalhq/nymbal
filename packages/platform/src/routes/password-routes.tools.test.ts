import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@nymbalhq/types'
import { createKernel, type Kernel } from '../../tests/support/kernel.js'
import { toolsOf } from '../mcp/registry.js'
import { RouteTable, recordingAdapter } from '../mcp/route-table.js'
import { routeSchemas } from './schemas.js'

// The password routes are the shopper's own: asking for a reset link, setting a password with one, and changing a
// password while signed in. Each is served, and none is a tool an agent can call, over a route table filled the way
// attachHttp fills the app's own.

const PASSWORD_ROUTES = [
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  'PATCH /api/customers/me/password',
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

describe('AC-21: the password routes are kept from agents', () => {
  it('AC-21: the three password routes are registered, and none of them is in the agent tool list', () => {
    const served = PASSWORD_ROUTES.filter((key) => table.keys().includes(key))
    const asTools = tools
      .map((t) => `${t.route.method} ${t.route.path}`)
      .filter((key) => PASSWORD_ROUTES.includes(key))

    expect(served).toEqual(PASSWORD_ROUTES)
    expect(asTools).toEqual([])
    // Each is kept by its schema entry, not by chance: every one says `tool: false`.
    expect(served.map((key) => routeSchemas[key]?.tool)).toEqual(served.map(() => false))
  })
})
