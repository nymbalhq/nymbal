import type { APIRequestContext, Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { expect, test } from '../../support/fixtures'
import { API_URL, csrf } from '../../support/csrf'
import { ADMIN_EMAIL, placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'

// AC-7 and AC-8. AC-7: a product the test creates through the API (a seeded one has no base event) opens at
// /admin/products/<slug> with the name and short description its admin GET answers; the admin edits both and
// double-clicks Save, which applies one `product.update`; the admin adjusts its stock on the inventory page. Its
// History tab lists the stock change and the edit newest first, with the fields from → to, the admin and the command,
// as `…/history` lists them; "view as of" on the base shows the record before the edit, as `?at=` answers it.
// AC-8: an order placed through the API, moved to processing, shipped and partially refunded by the admin, lists
// those changes newest first, and "view as of" on the shipped entry shows status shipped and refunded 0, as the API
// read right after the ship did; a customer registered and updated through the storefront API lists both entries, the
// update naming the edited field.

interface Change {
  path: string
  from: unknown
  to: unknown
}

interface Entry {
  seq: number
  at: string
  type: string
  correlationId: string
  actor: { kind: string; id: string } | null
  command: string | null
  base: boolean
  changes: Change[]
}

type Json = Record<string, unknown>

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function apiGet<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const res = await request.get(`${API_URL}${path}`, { headers: auth(token) })
  expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: T }).data
}

async function apiPost<T = unknown>(
  request: APIRequestContext,
  token: string,
  path: string,
  data: unknown = {},
): Promise<T> {
  const res = await request.post(`${API_URL}${path}`, {
    headers: { ...(await csrf(request)), ...auth(token) },
    data,
  })
  expect(res.ok(), `POST ${path}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: T }).data
}

const historyOf = (
  request: APIRequestContext,
  token: string,
  collection: 'products' | 'orders' | 'customers',
  id: string,
) =>
  apiGet<{ historyStartsAt: string | null; entries: Entry[] }>(
    request,
    token,
    `/api/admin/${collection}/${id}/history?limit=200`,
  )

const asOf = (request: APIRequestContext, token: string, detail: string, at: string) =>
  apiGet<{ record: Json }>(request, token, `${detail}?at=${encodeURIComponent(at)}`)

/** The seqs of the tab's rows, top to bottom (`history-row-<seq>`, not its `-actor` and `-command` cells). */
async function rowSeqs(page: Page): Promise<number[]> {
  const ids = await page
    .locator('[data-testid^="history-row-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''))
  return ids.filter((id) => /^history-row-\d+$/.test(id)).map((id) => Number(id.slice(12)))
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A draft product of this journey, listed by the admin inventory before this returns (no other journey buys it). */
async function draftProduct(request: APIRequestContext, token: string) {
  const tag = randomUUID().slice(0, 8)
  const created = await apiPost<{ id: string; slug: string; variants: Array<{ id: string }> }>(
    request,
    token,
    '/api/admin/products',
    {
      slug: `history-${tag}`,
      name: `History Journey ${tag}`,
      description: 'A product of one history journey.',
      shortDescription: `Short ${tag}`,
      status: 'draft',
      variants: [{ sku: `P303-${tag}`, name: 'Default', priceMinor: 2400, stock: 10, options: [] }],
    },
  )
  const product = { id: created.id, slug: created.slug, variantId: created.variants[0]!.id }
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `${API_URL}/api/admin/inventory?q=${encodeURIComponent(`History Journey ${tag}`)}`,
          { headers: auth(token) },
        )
        const rows = ((await res.json()) as { data?: Array<{ variantId: string }> }).data ?? []
        return rows.some((r) => r.variantId === product.variantId)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return { ...product, search: `History Journey ${tag}` }
}

/** Counts the page's requests matching `matches`; `settled()` waits until every one sent has been answered. */
function inFlight(page: Page, matches: (method: string, path: string) => boolean) {
  let sent = 0
  let answered = 0
  const ours = (r: { method(): string; url(): string }) =>
    matches(r.method(), new URL(r.url()).pathname)
  page.on('request', (r) => {
    if (ours(r)) sent += 1
  })
  page.on('requestfinished', (r) => {
    if (ours(r)) answered += 1
  })
  page.on('requestfailed', (r) => {
    if (ours(r)) answered += 1
  })
  return {
    sent: () => sent,
    async settled() {
      await expect
        .poll(() => sent > 0 && sent === answered, { message: 'requests in flight' })
        .toBe(true)
    },
  }
}

test.describe('AC-7 and AC-8: the History tab', () => {
  test('AC-7 history.product-edit-loads, history.lists-changes, history.as-of-matches: the edit page opens with its GET’s fields, a double-clicked Save applies once, the tab lists the stock change and the edit, and "view as of" on the base shows the record before the edit', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const me = await apiGet<{ userId: string }>(request, token, '/api/admin/me')
    const product = await draftProduct(request, token)
    const before = await apiGet<Json>(request, token, `/api/admin/products/${product.slug}`)
    await signInAsAdmin(page)

    await page.goto(`products/${product.slug}`)
    const name = page.getByTestId('admin-product-name')
    const shortDescription = page
      .getByText('Short Description', { exact: true })
      .locator('xpath=..')
      .locator('textarea')
    await expect(name).toHaveValue(String(before['name']), { timeout: 15_000 })
    await expect(shortDescription).toHaveValue(String(before['shortDescription']))

    const newName = `${String(before['name'])} Edited`
    const newShort = `${String(before['shortDescription'])} edited`
    await name.fill(newName)
    await shortDescription.fill(newShort)
    const patches = inFlight(
      page,
      (method, path) => method === 'PATCH' && path === `/api/admin/products/${product.id}`,
    )
    await page.getByTestId('admin-product-save').dblclick()
    await patches.settled()
    const activity = await apiGet<
      Array<{ command: string; outcome: string; subjects: Array<{ id: string }> }>
    >(request, token, '/api/admin/activity?command=product.update&limit=100')
    expect(
      activity.filter(
        (e) =>
          e.command === 'product.update' &&
          e.outcome === 'applied' &&
          e.subjects.some((s) => s.id === product.id),
      ).length,
      'applied product.update entries for the product after a double-clicked Save',
    ).toBe(1)

    await page.goto('inventory')
    await page.getByPlaceholder('Search SKU or product...').fill(product.search)
    const adjustRow = page.getByTestId(`admin-inventory-adjust-${product.variantId}`)
    await expect(adjustRow).toBeVisible({ timeout: 15_000 })
    await adjustRow.getByRole('spinbutton').fill('2')
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          new URL(res.url()).pathname === `/api/admin/inventory/${product.variantId}/adjust`,
      ),
      adjustRow.getByRole('button', { name: 'Apply' }).click(),
    ])

    const { entries } = await historyOf(request, token, 'products', product.id)
    const stockPath = `variants.${product.variantId}.stock`
    const [stock, edit, base] = entries
    expect(entries.map((e) => e.type.split('.v')[0])).toEqual([
      'inventory.changed',
      'product.updated',
      'product.created',
    ])
    expect(stock!.changes.map((c) => c.path)).toEqual([stockPath])
    expect(Number(stock!.changes[0]!.to) - Number(stock!.changes[0]!.from)).toBe(2)
    expect(
      ['name', 'shortDescription'].map((path) => edit!.changes.find((c) => c.path === path)),
    ).toEqual([
      { path: 'name', from: before['name'], to: newName },
      { path: 'shortDescription', from: before['shortDescription'], to: newShort },
    ])
    expect([edit!.actor?.id, edit!.command]).toEqual([me.userId, 'product.update'])
    expect(base!.base).toBe(true)

    await page.goto(`products/${product.slug}`)
    await page.getByTestId('admin-product-tab-history').click()
    await expect(page.getByTestId(`history-row-${stock!.seq}`)).toBeVisible({ timeout: 15_000 })
    expect(await rowSeqs(page), 'the tab’s rows, newest first, as …/history lists them').toEqual(
      entries.map((e) => e.seq),
    )
    const stockChange = page.getByTestId(`history-change-${stock!.seq}-${stockPath}`)
    await expect(stockChange).toContainText(String(stock!.changes[0]!.from))
    await expect(stockChange).toContainText(String(stock!.changes[0]!.to))
    for (const [path, from, to] of [
      ['name', before['name'], newName],
      ['shortDescription', before['shortDescription'], newShort],
    ] as const) {
      const shown = page.getByTestId(`history-change-${edit!.seq}-${path}`)
      await expect(shown).toContainText(String(from))
      await expect(shown).toContainText(String(to))
    }
    await expect(page.getByTestId(`history-row-${edit!.seq}-actor`)).toHaveText(
      new RegExp(`${escaped(me.userId)}|${escaped(ADMIN_EMAIL)}`),
    )
    await expect(page.getByTestId(`history-row-${edit!.seq}-command`)).toContainText(
      'product.update',
    )

    const record = (await asOf(request, token, `/api/admin/products/${product.id}`, base!.at))
      .record
    expect([record['name'], record['shortDescription']], '?at= the base').toEqual([
      before['name'],
      before['shortDescription'],
    ])
    await page.getByTestId(`history-as-of-${base!.seq}`).click()
    const panel = page.getByTestId('history-as-of-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('history-as-of-field-name')).toHaveText(
      new RegExp(`^\\s*${escaped(String(record['name']))}\\s*$`),
    )
    await expect(panel.getByTestId('history-as-of-field-shortDescription')).toHaveText(
      new RegExp(`^\\s*${escaped(String(record['shortDescription']))}\\s*$`),
    )
  })

  test('AC-8 history.lists-changes, history.as-of-matches: an order’s tab lists processing, shipped and the partial refund newest first, and "view as of" on the shipped entry shows status shipped and refunded 0, as the read after the ship; a customer’s tab lists registration and update, the update naming its field', async ({
    page,
    request,
    playwright,
  }) => {
    const token = await adminToken(request)
    const order = await placeOrder(
      request,
      `e2e-history-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
    )
    const detail = `/api/admin/orders/${order.orderNumber}`
    await apiPost(request, token, `/api/admin/orders/${order.orderId}/process`)
    await apiPost(request, token, `/api/admin/orders/${order.orderId}/ship`, {
      trackingNumber: 'TRK-AC8',
      carrier: 'Royal Mail',
    })
    const afterShip = await apiGet<Json & { payment: { refundedMinor: number } }>(
      request,
      token,
      detail,
    )
    const refundMinor = 150
    await apiPost(request, token, `/api/admin/orders/${order.orderId}/refund`, {
      amountMinor: refundMinor,
      reason: 'AC-8',
    })

    const orderHistory = await historyOf(request, token, 'orders', order.orderId)
    const [refunded, shipped, processed] = orderHistory.entries
    expect(orderHistory.entries.slice(0, 3).map((e) => e.type.split('.v')[0])).toEqual([
      'order.partially_refunded',
      'order.shipped',
      'order.status_changed',
    ])
    const shippedAt = await asOf(request, token, detail, shipped!.at)
    expect(
      [shippedAt.record['status'], shippedAt.record['refundedMinor']],
      '?at= the ship equals the read right after it',
    ).toEqual([afterShip['status'], afterShip['refundedMinor']])
    expect(afterShip['status']).toBe('shipped')
    expect(afterShip['refundedMinor']).toBe(0)

    await signInAsAdmin(page)
    await page.goto(`orders/${order.orderNumber}`)
    await page.getByTestId('admin-order-tab-history').click()
    await expect(page.getByTestId(`history-row-${refunded!.seq}`)).toBeVisible({ timeout: 15_000 })
    expect(await rowSeqs(page)).toEqual(orderHistory.entries.map((e) => e.seq))
    for (const [entry, to] of [
      [processed, 'processing'],
      [shipped, 'shipped'],
    ] as const) {
      await expect(page.getByTestId(`history-change-${entry!.seq}-status`)).toContainText(to)
    }
    await page.getByTestId(`history-as-of-${shipped!.seq}`).click()
    const panel = page.getByTestId('history-as-of-panel')
    await expect(panel.getByTestId('history-as-of-field-status')).toContainText(/shipped/i)
    const refundedField = panel.getByTestId('history-as-of-field-refundedMinor')
    await expect(refundedField).toHaveText(/(^|[^\d.,])0(\.00)?\s*$/)
    await expect(refundedField).not.toContainText(String(refundMinor))
    await expect(refundedField).not.toContainText((refundMinor / 100).toFixed(2))

    // The customer, through the storefront API, in a request context of its own.
    const shopper = await playwright.request.newContext()
    try {
      const email = `e2e-history-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`
      const registered = await shopper.post(`${API_URL}/api/auth/register`, {
        headers: await csrf(shopper),
        data: { email, password: 'history-correct-horse' },
      })
      expect(registered.status(), await registered.text()).toBe(201)
      const { customer, accessToken } = (
        (await registered.json()) as { data: { customer: { id: string }; accessToken: string } }
      ).data
      const firstName = `Hist${randomUUID().slice(0, 6)}`
      const updated = await shopper.patch(`${API_URL}/api/customers/me`, {
        headers: { ...(await csrf(shopper)), ...auth(accessToken) },
        data: { firstName },
      })
      expect(updated.status(), await updated.text()).toBe(200)

      const customerHistory = await historyOf(request, token, 'customers', customer.id)
      const [update, registration] = customerHistory.entries
      expect(customerHistory.entries.map((e) => e.type.split('.v')[0])).toEqual([
        'customer.updated',
        'customer.created',
      ])
      expect(update!.changes.find((c) => c.path === 'firstName')?.to).toBe(firstName)
      expect(registration!.base).toBe(true)

      await page.goto(`customers/${customer.id}`)
      await page.getByTestId('admin-customer-tab-history').click()
      await expect(page.getByTestId(`history-row-${update!.seq}`)).toBeVisible({ timeout: 15_000 })
      expect(await rowSeqs(page)).toEqual(customerHistory.entries.map((e) => e.seq))
      await expect(page.getByTestId(`history-change-${update!.seq}-firstName`)).toContainText(
        firstName,
      )
    } finally {
      await shopper.dispose()
    }
  })
})
