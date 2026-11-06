import type { APIRequestContext } from '@playwright/test'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// AC-12: a shopping agent opens a checkout at the store's UCP endpoint and hands it to the buyer; the buyer's browser
// opens the answer's continue_url and the storefront's checkout shows the agent's lines, on either template.

interface ApiCart {
  data: { items: Array<{ variantId: string; qty: number }> }
}

/** `create_checkout` at the API's UCP MCP endpoint, as any agent calls it: one JSON-RPC POST, no cookie. */
async function createCheckout(
  request: APIRequestContext,
  lines: Array<{ variantId: string; quantity: number }>,
): Promise<{ id: string; continueUrl: string }> {
  const res = await request.post(`${API_URL}/api/ucp/mcp`, {
    headers: { accept: 'application/json, text/event-stream' },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_checkout',
        arguments: {
          checkout: {
            line_items: lines.map((l) => ({ item: { id: l.variantId }, quantity: l.quantity })),
          },
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
    result?: { isError?: boolean; structuredContent?: { id?: string; continue_url?: string } }
  }
  const checkout = message.result?.structuredContent
  expect(message.result?.isError ?? false, `create_checkout: ${text}`).toBe(false)
  return { id: String(checkout?.id), continueUrl: String(checkout?.continue_url) }
}

const pairs = (cart: ApiCart) =>
  cart.data.items
    .map((item) => ({ variantId: item.variantId, qty: item.qty }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId))

test.describe('Agent checkout handoff', () => {
  test("AC-12: a browser that held another cart opens an agent's continue_url, and /checkout shows exactly the agent's two lines at its quantities, the badge their sum, and GET /api/cart the same lines", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const [first, second, other] = (await Promise.all(
      [10, 10, 10].map(() => ownProduct(request, token, 10)),
    )) as [OwnProduct, OwnProduct, OwnProduct]
    const wanted = [
      { variantId: first.variantId, qty: 2 },
      { variantId: second.variantId, qty: 1 },
    ].sort((a, b) => a.variantId.localeCompare(b.variantId))

    // The browser's own cart first: one unit of a product the agent does not ask for.
    const held = await page.request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(page.request),
      data: { variantId: other.variantId, qty: 1 },
    })
    expect(held.status(), `POST /api/cart/items: ${await held.text()}`).toBe(200)

    const checkout = await createCheckout(request, [
      { variantId: first.variantId, quantity: 2 },
      { variantId: second.variantId, quantity: 1 },
    ])
    const handoff = await page.request.get(checkout.continueUrl, { maxRedirects: 0 })
    await page.goto('/checkout')
    const summary = page.getByTestId('checkout-summary')
    const lines = summary.locator('[part="item"]')
    const cart = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart

    expect(handoff.status()).toBe(303)
    expect(new URL(handoff.headers()['location'] ?? '', API_URL).pathname).toBe('/checkout')
    await expect(lines).toHaveCount(wanted.length, { timeout: 10_000 })
    for (const [product, qty] of [
      [first, 2],
      [second, 1],
    ] as const) {
      const line = lines.filter({ hasText: product.name })
      await expect(line).toHaveCount(1)
      await expect(line.locator('[part="item-qty"]')).toHaveText(`x${qty}`)
    }
    await expect(summary).not.toContainText(other.name)
    await expect(page.getByTestId('mini-cart-badge')).toHaveText(
      String(wanted.reduce((sum, w) => sum + w.qty, 0)),
      { timeout: 10_000 },
    )
    expect(pairs(cart)).toEqual(wanted)
  })
})
