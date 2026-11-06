import { randomUUID } from 'node:crypto'
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { placeOrder, SHIPPING_ADDRESS, signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// AC-7: an operator sees which orders shopping agents brought. An agent opens a checkout at the store's UCP endpoint
// naming its profile; the buyer opens the answer's continue_url (which hands over the cart cookie) and pays at the
// API, the way the admin journeys place orders. The admin API and the order's page name the agent; a storefront
// order's page says storefront; the dashboard's Agents tile shows what its own answer holds, raised by the order.

interface AgentFigures {
  count: number
  revenueMinor: number
}

interface DashboardAnswer {
  data: { agents?: { orders: AgentFigures } }
}

async function dashboard(request: APIRequestContext, token: string): Promise<DashboardAnswer> {
  const res = await request.get(`${API_URL}/api/admin/dashboard`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/dashboard: ${await res.text()}`).toBe(200)
  return (await res.json()) as DashboardAnswer
}

/** `create_checkout` at the UCP MCP endpoint as an agent whose platform profile is at `profile`; no cookie. */
async function createCheckout(
  agent: APIRequestContext,
  profile: string,
  variantId: string,
): Promise<string> {
  const res = await agent.post(`${API_URL}/api/ucp/mcp`, {
    headers: { accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_checkout',
        arguments: {
          meta: { 'ucp-agent': { profile } },
          checkout: { line_items: [{ item: { id: variantId }, quantity: 1 }] },
        },
      },
    },
  })
  const text = await res.text()
  expect(res.status(), `POST /api/ucp/mcp: ${text}`).toBe(200)
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
  const message = JSON.parse(data.length > 0 ? data[data.length - 1]! : text) as {
    result?: { isError?: boolean; structuredContent?: { continue_url?: string } }
  }
  expect(message.result?.isError ?? false, `create_checkout: ${text}`).toBe(false)
  return String(message.result?.structuredContent?.continue_url)
}

test.describe('Agent orders in the admin', () => {
  test("AC-7: an order placed from an agent's continue_url is agent:<profile host> in GET /api/admin/orders/:orderNumber and on its page, a storefront order's page says storefront, and the dashboard's Agents tile shows the count and revenue of the answer it received, raised by the order, with the UCP surface's search, lookup and checkout handoff", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const host = `${randomUUID().slice(0, 8)}.agents.test`
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)
    const before = (await dashboard(request, token)).data.agents?.orders

    const agent = await playwrightRequest.newContext()
    const buyer = await playwrightRequest.newContext()
    const guest = await playwrightRequest.newContext()
    let orderNumber: string
    let storefrontNumber: string
    try {
      const continueUrl = await createCheckout(agent, `https://${host}/p`, product.variantId)
      // The buyer's browser opens the link: the 303 sets its cart cookie; nothing here sets one by hand.
      const handoff = await buyer.get(continueUrl, { maxRedirects: 0 })
      expect(handoff.status(), `GET ${continueUrl}`).toBe(303)
      const paid = await buyer.post(`${API_URL}/api/checkout`, {
        headers: await csrf(buyer),
        data: {
          email: `agent-buyer-${randomUUID().slice(0, 8)}@nymbal.dev`,
          billingAddress: SHIPPING_ADDRESS,
          shippingAddress: SHIPPING_ADDRESS,
        },
      })
      expect(paid.ok(), `POST /api/checkout: ${await paid.text()}`).toBe(true)
      orderNumber = ((await paid.json()) as { data: { orderNumber: string } }).data.orderNumber
      storefrontNumber = (await placeOrder(guest)).orderNumber
    } finally {
      await Promise.all([agent.dispose(), buyer.dispose(), guest.dispose()])
    }

    const read = await request.get(
      `${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(read.status(), await read.text()).toBe(200)
    const order = ((await read.json()) as { data: { source?: string; capturedMinor: number } }).data
    expect(order.source).toBe(`agent:${host}`)

    await signInAsAdmin(page)
    await page.goto(`orders/${encodeURIComponent(orderNumber)}`)
    const source = page.getByTestId('admin-order-source')
    await expect(source).toHaveAttribute('data-source', `agent:${host}`, { timeout: 15_000 })
    await expect(source).toContainText(host)

    await page.goto(`orders/${encodeURIComponent(storefrontNumber)}`)
    await expect(page.getByTestId('admin-order-source')).toHaveAttribute(
      'data-source',
      'storefront',
      { timeout: 15_000 },
    )

    const answered = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/admin/dashboard' && res.status() === 200,
    )
    await page.goto('')
    const figures = ((await (await answered).json()) as DashboardAnswer).data.agents?.orders
    await expect(page.getByTestId('admin-dashboard-agents-orders')).toHaveText(
      String(figures?.count),
      { timeout: 15_000 },
    )
    await expect(page.getByTestId('admin-dashboard-agents-revenue')).toHaveAttribute(
      'data-minor',
      String(figures?.revenueMinor),
    )
    expect(figures?.count ?? Number.NaN).toBeGreaterThanOrEqual((before?.count ?? Number.NaN) + 1)
    expect(figures?.revenueMinor ?? Number.NaN).toBeGreaterThanOrEqual(
      (before?.revenueMinor ?? Number.NaN) + order.capturedMinor,
    )
    const surface = page.getByTestId('admin-dashboard-agents-surface-ucp')
    await expect(surface).toContainText('search')
    await expect(surface).toContainText('lookup')
    await expect(surface).toContainText('checkout handoff')
  })
})
