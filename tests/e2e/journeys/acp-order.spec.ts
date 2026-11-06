import { randomUUID } from 'node:crypto'
import type { APIRequestContext, APIResponse } from '@playwright/test'
import { adminToken, ORDER_KEY_HEADER, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { formatPrice } from '../support/variants'

// AC-15: a shopping agent buys two products over ACP at the API (create, then complete with a delegated token the
// native payments pay), and the order link the session answers opens that order on either template: its number, both
// lines and the session's total.

interface Session {
  id: string
  status: string
  currency: string
  totals: Array<{ type: string; amount: number }>
  order?: { id: string; order_number: string; permalink_url: string }
}

/** The store's ACP key, which the run's API is started with and hands to the journeys. */
function acpKey(): string {
  const key = process.env['NYMBAL_ACP_API_KEY'] ?? ''
  expect(
    key.length,
    'NYMBAL_ACP_API_KEY: the E2E API runs with agents.acp on under this key',
  ).toBeGreaterThanOrEqual(32)
  return key
}

/** One ACP request as an agent sends it: the store's key, the pinned version, a fresh key on a POST. */
function acp(request: APIRequestContext, path: string, body: unknown): Promise<APIResponse> {
  return request.post(`${API_URL}/api/acp${path}`, {
    headers: {
      authorization: `Bearer ${acpKey()}`,
      'api-version': '2026-04-17',
      'idempotency-key': `e2e-${randomUUID()}`,
      'user-agent': 'E2E-Agent/1.0',
    },
    data: body,
  })
}

const totalOf = (session: Session) => session.totals.find((t) => t.type === 'total')?.amount

test.describe('ACP order link', () => {
  test("AC-15: after an ACP create and complete for two products at the API, opening the order's permalink_url path on this storefront shows that order number, exactly the two lines at their quantities and the session's total, and GET /api/orders/:n with the link's key reads the same total", async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const token = await adminToken(request)
    const [first, second] = (await Promise.all([
      ownProduct(request, token, 10),
      ownProduct(request, token, 10),
    ])) as [OwnProduct, OwnProduct]
    const wanted: Array<[OwnProduct, number]> = [
      [first, 2],
      [second, 1],
    ]

    const created = await acp(request, '/checkout_sessions', {
      line_items: wanted.map(([p, quantity]) => ({ id: p.variantId, quantity })),
      currency: 'gbp',
      capabilities: {},
      buyer: { email: `e2e-acp-${randomUUID().slice(0, 8)}@e2e.test` },
      fulfillment_details: {
        name: 'Ada Lovelace',
        address: {
          name: 'Ada Lovelace',
          line_one: '1 Agent Row',
          city: 'Leeds',
          state: 'West Yorkshire',
          country: 'GB',
          postal_code: 'LS1 4AP',
        },
      },
    })
    expect(created.status(), `POST /api/acp/checkout_sessions: ${await created.text()}`).toBe(201)
    const session = (await created.json()) as Session
    const completed = await acp(request, `/checkout_sessions/${session.id}/complete`, {
      payment_data: {
        handler_id: 'card_tokenized',
        instrument: { type: 'card', credential: { type: 'spt', token: 'spt_e2e' } },
      },
    })
    expect(completed.status(), `complete: ${await completed.text()}`).toBe(200)
    const done = (await completed.json()) as Session
    expect(done.status).toBe('completed')
    const link = new URL(done.order!.permalink_url)
    const total = totalOf(done)

    await page.goto(`${link.pathname}${link.search}`)
    const summary = page.getByTestId('order-summary')
    const lines = summary.locator('[part="line"]')
    const api = await request.get(
      `${API_URL}/api/orders/${encodeURIComponent(done.order!.order_number)}`,
      { headers: { [ORDER_KEY_HEADER]: link.searchParams.get('key') ?? '' } },
    )

    await expect(page.getByTestId('order-number')).toHaveText(done.order!.order_number, {
      timeout: 15_000,
    })
    await expect(lines).toHaveCount(wanted.length)
    for (const [product, qty] of wanted) {
      const line = lines.filter({ hasText: product.name })
      await expect(line).toHaveCount(1)
      await expect(line).toContainText(`× ${qty}`)
    }
    await expect(summary.locator('[part="total"]')).toContainText(
      formatPrice(total ?? -1, done.currency.toUpperCase()),
    )
    expect(api.status(), await api.text()).toBe(200)
    expect(((await api.json()) as { data: { totalMinor: number } }).data.totalMinor).toBe(total)
    expect(total).toBe(totalOf(session))
  })
})
