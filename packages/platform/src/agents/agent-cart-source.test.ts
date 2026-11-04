import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, seedVariant, type Seeded } from '../../tests/support/kernel.js'
import {
  agentCaller,
  cartTokenOf,
  openContinueUrl,
  serveWithAgents,
  storedCartSource,
  ucpCheckout,
  type AgentStore,
} from '../../tests/support/agents.js'
import { primedShopper } from '../../tests/support/security.js'
import { shopper } from '../../tests/support/shopper.js'
import { handoffPath } from './catalog.js'

// AC-3: every way a cart is opened records who opened it, read back through the cart repository on a SQLite store
// served as `nymbal dev` serves it. An agent's tool call is `agent:<name>`, over the UCP endpoint and over /api/mcp; an
// HTTP request is `storefront` whatever headers it sends; and no later storefront write changes a cart's source.

const CLIENT = 'acme-bot'
const PROFILE_HOST = 'agent.example'

let store: AgentStore
let seeded: Seeded
let customerId: string

beforeAll(async () => {
  store = await serveWithAgents(await createKernel({ dialect: 'sqlite' }))
  seeded = await seedVariant(store.kernel, 100_000)
  const { customer } = await store.kernel.services.auth.register({
    email: `source-${randomUUID()}@cart.test`,
    password: 'source-correct-horse',
  })
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

/**
 * An MCP SDK client over Streamable HTTP at `path`, introducing itself as `name` on every request (the 2026-07-28
 * revision's envelope, negotiated). A 2025-era client names itself only in `initialize`, which a stateless endpoint
 * does not see again on a tool call.
 */
async function client(path: string, name: string): Promise<Client> {
  const c = new Client({ name, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  await c.connect(new StreamableHTTPClientTransport(new URL(path, store.baseUrl)))
  return c
}

function structured(result: unknown): Record<string, unknown> {
  const r = result as { isError?: boolean; structuredContent?: Record<string, unknown> }
  if (r.isError === true)
    throw new Error(`the tool refused: ${JSON.stringify(r.structuredContent)}`)
  return r.structuredContent ?? {}
}

describe('AC-3: a cart records who opened it', () => {
  it(`AC-3: UCP create_checkout from client ${CLIENT} records agent:<profile host> when meta names a ucp-agent profile, and agent:${CLIENT} with no meta`, async () => {
    const ucp = await client('/api/ucp/mcp', CLIENT)
    try {
      const line_items = [{ item: { id: seeded.variantId }, quantity: 1 }]
      const withProfile = structured(
        await ucp.callTool({
          name: 'create_checkout',
          arguments: {
            meta: { 'ucp-agent': { profile: `https://${PROFILE_HOST}/p` } },
            checkout: { line_items },
          },
        }),
      )
      const withoutMeta = structured(
        await ucp.callTool({ name: 'create_checkout', arguments: { checkout: { line_items } } }),
      )

      expect(withProfile['id']).not.toBe(withoutMeta['id'])
      expect([
        await storedCartSource(store.kernel, String(withProfile['id'])),
        await storedCartSource(store.kernel, String(withoutMeta['id'])),
      ]).toEqual([`agent:${PROFILE_HOST}`, `agent:${CLIENT}`])
    } finally {
      await ucp.close()
    }
  }, 30_000)

  it(`AC-3: on /api/mcp, cart_get and cart_addItem with no cart handle, from client ${CLIENT}, each open a cart recorded agent:${CLIENT}`, async () => {
    const mcp = await client('/api/mcp', CLIENT)
    try {
      const opened = structured(await mcp.callTool({ name: 'cart_get', arguments: {} }))
      const added = structured(
        await mcp.callTool({
          name: 'cart_addItem',
          arguments: { variantId: seeded.variantId, qty: 1 },
        }),
      )
      const tokens = [String(opened['cartHandle']), String(added['cartHandle'])]

      expect(new Set(tokens).size).toBe(2)
      expect([
        await storedCartSource(store.kernel, tokens[0]!),
        await storedCartSource(store.kernel, tokens[1]!),
      ]).toEqual([`agent:${CLIENT}`, `agent:${CLIENT}`])
    } finally {
      await mcp.close()
    }
  }, 30_000)

  it('AC-3: over HTTP with no cart cookie, GET /api/cart and POST /api/cart/items open a storefront cart, with or without x-nymbal-agent and user-agent headers naming an agent', async () => {
    const forged = { 'x-nymbal-agent': 'forged', 'user-agent': 'forged' }
    const sources: Array<{ how: string; source: string | undefined }> = []
    for (const headers of [{}, forged]) {
      const how = headers === forged ? 'forged headers' : 'plain'

      const reader = shopper(store.baseUrl)
      const got = await reader.call('GET', '/api/cart', undefined, { headers })
      expect(got.status, JSON.stringify(got.body)).toBe(200)
      sources.push({
        how: `GET ${how}`,
        source: await storedCartSource(store.kernel, cartTokenOf(reader.jar)),
      })

      const adder = await primedShopper(store.baseUrl)
      const posted = await adder.call(
        'POST',
        '/api/cart/items',
        { variantId: seeded.variantId, qty: 1 },
        { headers },
      )
      expect(posted.status, JSON.stringify(posted.body)).toBe(200)
      sources.push({
        how: `POST ${how}`,
        source: await storedCartSource(store.kernel, cartTokenOf(adder.jar)),
      })
    }

    expect(sources).toEqual(sources.map(({ how }) => ({ how, source: 'storefront' })))
  }, 30_000)

  type Write = 'add' | 'update' | 'remove' | 'clear' | 'handoff' | 'attachCustomer'
  const WRITES: Write[] = ['add', 'update', 'remove', 'clear', 'handoff', 'attachCustomer']

  // Kills: a later write that rewrites the source (a spread that drops it, an upsert that resets it to the column
  // default, a handoff or a customer attach that re-tags the cart).
  it("AC-3: property: after any sequence of storefront writes (add, update, remove, clear, the handoff route, attachCustomer) a cart's source is still the one it was opened with, agent or storefront", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('agent', 'storefront'),
        fc.array(fc.constantFrom(...WRITES), { minLength: 1, maxLength: 8 }),
        async (opener, writes) => {
          const browser = await primedShopper(store.baseUrl)
          let token: string
          let opened: string
          if (opener === 'agent') {
            const checkout = await ucpCheckout(store, agentCaller(CLIENT), [seeded.variantId])
            await openContinueUrl(checkout.continueUrl, browser.jar)
            token = checkout.token
            opened = `agent:${CLIENT}`
          } else {
            await browser.call('GET', '/api/cart')
            token = cartTokenOf(browser.jar)
            opened = 'storefront'
          }
          const item = `/api/cart/items/${encodeURIComponent(seeded.variantId)}`

          const seen: Array<{ after: string; source: string | undefined }> = [
            { after: 'opening', source: await storedCartSource(store.kernel, token) },
          ]
          for (const write of writes) {
            if (write === 'add') {
              await browser.call('POST', '/api/cart/items', { variantId: seeded.variantId, qty: 1 })
            } else if (write === 'update') {
              await browser.call('PATCH', item, { qty: 2 })
            } else if (write === 'remove') {
              await browser.call('DELETE', item)
            } else if (write === 'clear') {
              await browser.call('DELETE', '/api/cart')
            } else if (write === 'handoff') {
              await openContinueUrl(`${store.baseUrl}${handoffPath(token)}`, browser.jar)
            } else {
              await store.kernel.services.cart.attachCustomer(token, customerId)
            }
            seen.push({ after: write, source: await storedCartSource(store.kernel, token) })
          }

          expect(seen).toEqual(seen.map(({ after }) => ({ after, source: opened })))
        },
      ),
      { numRuns: 12 },
    )
  }, 120_000)
})
