import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { ToolDefinition } from '@nymbalhq/types'
import { assistantTools } from '../../src/assistant/loop.js'
import { agentCaller, serveWithAgents, type AgentStore } from '../support/agents.js'
import { address, createKernel, seedVariant, type Seeded } from '../support/kernel.js'
import { both, TABLE, withShipping } from '../support/shipping.js'

// An MCP agent on /api/mcp, served as `nymbal dev` serves it (SQLite), on a store whose shipping costs money and which
// lets an agent's checkout run at the call (`agents.autoApprove`): it can learn the total it must acknowledge from
// `checkout_quote`, and place at that total; the admin's assistant is never offered the shopper's quote.

let store: AgentStore
let seeded: Seeded

beforeAll(async () => {
  const approvePlace = (config: NymbalConfig): NymbalConfig => ({
    ...config,
    agents: { ...config.agents, autoApprove: ['checkout.place'] },
  })
  store = await serveWithAgents(
    await createKernel({ dialect: 'sqlite', configure: both(withShipping(TABLE), approvePlace) }),
  )
  seeded = await seedVariant(store.kernel, 1_000, { priceMinor: 1_200 })
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

async function anonymousAgent(): Promise<Client> {
  const c = new Client(
    { name: 'quote-bot', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  )
  await c.connect(new StreamableHTTPClientTransport(new URL('/api/mcp', store.baseUrl)))
  return c
}

function structured(result: unknown): Record<string, unknown> {
  const r = result as { isError?: boolean; structuredContent?: Record<string, unknown> }
  if (r.isError === true) {
    throw new Error(`the tool refused: ${JSON.stringify(r.structuredContent ?? result)}`)
  }
  return r.structuredContent ?? {}
}

describe('AC-12: checkout_quote on /api/mcp', () => {
  // Kills: the quote route left off the agent surface, or listed without the cart handle an agent's cart travels in;
  // or the admin's assistant offered a shopper's checkout tool.
  it('AC-12: /api/mcp lists checkout_quote taking a cart handle, and assistantTools leaves it out of what it offers', async () => {
    const mcp = await anonymousAgent()
    try {
      const { tools } = await mcp.listTools()
      const quoteTool = tools.find((t) => t.name === 'checkout_quote')

      expect(tools.map((t) => t.name)).toContain('checkout_quote')
      expect(Object.keys(quoteTool?.inputSchema.properties ?? {})).toContain('cart')
    } finally {
      await mcp.close()
    }
    const listed = store.mcp.list(agentCaller('quote-bot'))
    const offered = assistantTools(listed).map((t: ToolDefinition) => t.name)
    expect(listed.map((t: ToolDefinition) => t.name)).toContain('checkout_quote')
    expect(offered).not.toContain('checkout_quote')
  }, 30_000)

  // Kills: an agent with no way to learn the total it must acknowledge, so every agent checkout on a store that
  // charges shipping is refused.
  it('AC-12: an anonymous agent that adds an item, quotes with an address, then begins checkout with the quote’s option and total gets an order at that total, shipping included', async () => {
    const mcp = await anonymousAgent()
    try {
      const added = structured(
        await mcp.callTool({
          name: 'cart_addItem',
          arguments: { variantId: seeded.variantId, qty: 2 },
        }),
      )
      const cart = added['cartHandle']

      const quoted = structured(
        await mcp.callTool({
          name: 'checkout_quote',
          arguments: { cart, shippingAddress: address },
        }),
      ) as {
        shippingOptionId?: string
        totals?: { totalMinor: number; shippingTotalMinor: number }
      }
      expect(quoted.shippingOptionId).toBe('standard')
      expect(quoted.totals?.shippingTotalMinor).toBe(399)

      const placed = structured(
        await mcp.callTool({
          name: 'checkout_begin',
          arguments: {
            cart,
            email: `agent-${randomUUID()}@mcp-quote.test`,
            billingAddress: address,
            shippingAddress: address,
            shippingOptionId: quoted.shippingOptionId,
            expectedTotalMinor: quoted.totals?.totalMinor,
          },
        }),
      )

      const order = await store.kernel.store.read((tx) =>
        store.kernel.repos.order.findByOrderNumber(tx, String(placed['orderNumber'])),
      )
      expect(order?.totalMinor).toBe(quoted.totals?.totalMinor)
      expect(order?.totalMinor).toBe(2 * 1_200 + 399)
      expect(order?.shippingTotalMinor).toBe(399)
    } finally {
      await mcp.close()
    }
  }, 30_000)
})
