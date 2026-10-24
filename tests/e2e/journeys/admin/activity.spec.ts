import type { APIRequestContext, Page, Request, Response } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '../../support/fixtures'
import { API_URL, csrf } from '../../support/csrf'
import { placeOrder, SHIPPING_ADDRESS, signInAsAdmin } from '../../support/admin'
import { adminToken, type OwnProduct } from '../../support/checkout'

// AC-5: the admin's own requests, captured as the page sends them. A stock adjust re-sent once with the same headers
// is answered as a replay and moves stock once. /admin/activity lists the admin's adjust, order cancel and product
// save newest first, each with the admin's actor, its command, its subjects and the correlation id of its request; the
// adjust shows one applied and one replayed entry; filters by command, subject and correlation id narrow to those; the
// export's NDJSON lines equal the activity API's entries and carry no email, address or cart cookie. The stock-history
// drawer shows the adjustment.

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

interface Entry {
  id: string
  at: string
  actor: { kind: string; id: string }
  command: string
  subjects: Array<{ type: string; id: string }>
  correlationId: string
  outcome: 'applied' | 'refused' | 'replayed'
  responseStatus: number | null
  [field: string]: unknown
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function activity(
  request: APIRequestContext,
  token: string,
  query: Record<string, string> = {},
): Promise<Entry[]> {
  const params = new URLSearchParams({ limit: '100', ...query })
  const res = await request.get(`${API_URL}/api/admin/activity?${params.toString()}`, {
    headers: auth(token),
  })
  expect(res.status(), `GET /api/admin/activity?${params.toString()}: ${await res.text()}`).toBe(
    200,
  )
  return ((await res.json()) as { data: Entry[] }).data
}

/** The headers the page sent, minus the ones the request context sets for itself. */
function resendable(headers: Record<string, string>): Record<string, string> {
  const own = new Set(['host', 'content-length', 'connection', 'cookie', 'accept-encoding'])
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith(':') && !own.has(name)),
  )
}

/** Waits for the page's request matching `method` and `path` and its answer, while `act` runs. */
async function captured(
  page: Page,
  method: string,
  path: string,
  act: () => Promise<void>,
): Promise<{ request: Request; response: Response }> {
  const matches = (r: Request) => r.method() === method && new URL(r.url()).pathname === path
  const [request, response] = await Promise.all([
    page.waitForRequest(matches),
    page.waitForResponse((res) => matches(res.request())),
    act(),
  ])
  return { request, response }
}

/** Adjusts the variant's stock by `delta` through the inventory page. */
async function adjustThroughPage(page: Page, product: OwnProduct, delta: number) {
  await page.goto('inventory')
  await page.getByPlaceholder('Search SKU or product...').fill(product.name)
  const row = page.getByTestId(`admin-inventory-adjust-${product.variantId}`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole('spinbutton').fill(String(delta))
  return captured(page, 'POST', `/api/admin/inventory/${product.variantId}/adjust`, () =>
    row.getByRole('button', { name: 'Apply' }).click(),
  )
}

/** The admin's adjust request, sent once more by the test with the very headers and body the page sent. */
async function resend(page: Page, request: Request) {
  return page.request.post(request.url(), {
    headers: resendable(await request.allHeaders()),
    data: request.postData() ?? '',
  })
}

async function stockOf(request: APIRequestContext, token: string, product: OwnProduct) {
  const res = await request.get(
    `${API_URL}/api/admin/inventory?q=${encodeURIComponent(product.name)}`,
    { headers: auth(token) },
  )
  expect(res.ok(), await res.text()).toBe(true)
  const rows = ((await res.json()) as { data: Array<{ variantId: string; stock: number }> }).data
  return rows.find((r) => r.variantId === product.variantId)!.stock
}

async function historyOf(request: APIRequestContext, token: string, product: OwnProduct) {
  const res = await request.get(`${API_URL}/api/admin/inventory/${product.variantId}/history`, {
    headers: auth(token),
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: Array<{ adjustment: number }> }).data
}

/**
 * A draft product with one variant at `stock`, listed by the admin inventory before this returns. Draft, because
 * `placeOrder` skips drafts, so no other journey's checkout buys it and moves its stock (the storefront does serve it).
 */
async function draftProduct(
  request: APIRequestContext,
  token: string,
  stock: number,
): Promise<OwnProduct> {
  const tag = randomUUID().slice(0, 8)
  const name = `Activity Draft ${tag}`
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), ...auth(token) },
    data: {
      slug: `audit-${tag}`,
      name,
      description: 'A draft product of one activity journey.',
      status: 'draft',
      variants: [{ sku: `P304-${tag}`, name: 'Default', priceMinor: 1999, stock, options: [] }],
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  const body = (await res.json()) as { data: { slug: string; variants: Array<{ id: string }> } }
  const product = { slug: body.data.slug, variantId: body.data.variants[0]!.id, name }
  await expect
    .poll(
      async () => {
        const listed = await request.get(
          `${API_URL}/api/admin/inventory?q=${encodeURIComponent(name)}`,
          { headers: auth(token) },
        )
        const rows = ((await listed.json()) as { data?: Array<{ variantId: string }> }).data ?? []
        return rows.some((r) => r.variantId === product.variantId)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return product
}

/** Sets an activity filter, whichever control the page uses for it. */
async function filterBy(page: Page, which: 'actor' | 'command' | 'subject', value: string) {
  const control = page.getByTestId(`activity-filter-${which}`)
  if ((await control.evaluate((el) => el.tagName)) === 'SELECT') await control.selectOption(value)
  else await control.fill(value)
}

/** The entry ids of the page's rows, top to bottom. */
async function rowIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="activity-row-"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid') ?? ''))
  return ids.map((id) => id.slice('activity-row-'.length))
}

test.describe('AC-5: retry and the Activity page', () => {
  test('AC-5 audit.retry-applies-once: the admin’s adjust, re-sent with its own headers, is answered as a replay and moves stock once', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const product = await draftProduct(request, token, 10)
    await signInAsAdmin(page)

    const before = await stockOf(request, token, product)
    const first = await adjustThroughPage(page, product, 3)
    const key = (await first.request.allHeaders())['idempotency-key'] ?? ''
    expect(KEY_PATTERN.test(key), `the page's Idempotency-Key ${JSON.stringify(key)}`).toBe(true)
    const firstBody = (await first.response.json()) as unknown
    const replay = await resend(page, first.request)

    expect(replay.status(), await replay.text()).toBe(first.response.status())
    expect((await replay.json()) as unknown).toEqual(firstBody)
    expect(replay.headers()['idempotent-replayed']).toBe('true')
    const after = await stockOf(request, token, product)
    expect(after - before, `stock ${before} before the adjust, ${after} after its replay`).toBe(3)
    expect(
      (await historyOf(request, token, product)).filter((h) => h.adjustment === 3).length,
      'the +3 rows in GET …/history',
    ).toBe(1)
  })

  test('AC-5: the stock-history drawer lists the variant’s adjustments as GET …/history answers them', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const product = await draftProduct(request, token, 10)
    await signInAsAdmin(page)

    const first = await adjustThroughPage(page, product, 2)
    expect(first.response.ok(), await first.response.text()).toBe(true)
    const history = await historyOf(request, token, product)
    await page
      .getByTestId(`admin-inventory-row-${product.variantId}`)
      .getByRole('button', { name: 'History' })
      .click()
    const drawer = page.getByRole('dialog')

    expect(history.length, 'the fixture: the adjustment in GET …/history').toBe(1)
    await expect(drawer.locator('tbody tr')).toHaveCount(history.length, { timeout: 10_000 })
    await expect(drawer.locator('tbody tr').first()).toContainText(`+${history[0]!.adjustment}`)
  })

  test('AC-5 audit.activity-lists-commands: /admin/activity lists the admin’s adjust (applied and replayed), cancel and product save newest first, filters narrow them, and the export equals the API without PII', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const me = await request.get(`${API_URL}/api/admin/me`, { headers: auth(token) })
    const adminId = ((await me.json()) as { data: { userId: string } }).data.userId
    const stocked = await draftProduct(request, token, 10)
    const email = `e2e-audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}+stub-pending@nymbal.dev`
    const order = await placeOrder(request, email)
    const cartCookies = (await request.storageState()).cookies
      .filter((c) => c.name === 'nymbal.cart')
      .map((c) => c.value)
    await signInAsAdmin(page)

    const adjusted = await adjustThroughPage(page, stocked, 4)
    const replay = await resend(page, adjusted.request)
    expect(replay.headers()['idempotent-replayed'], await replay.text()).toBe('true')

    await page.goto(`orders/${order.orderNumber}`)
    await expect(page.getByTestId('admin-order-detail')).toContainText(order.orderNumber, {
      timeout: 15_000,
    })
    const cancelled = await captured(
      page,
      'POST',
      `/api/admin/orders/${order.orderId}/cancel`,
      async () => {
        await page.getByTestId('admin-order-actions').click()
        await page.getByRole('menuitem', { name: 'Cancel order' }).click()
      },
    )

    // The product form saves a product the admin names here: an existing product cannot be loaded into the form (the
    // admin API has no GET /api/admin/products/:slug, phone-width.spec.ts).
    await page.goto('products/new')
    const productName = `Activity Journey ${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    await page.getByTestId('admin-product-name').fill(productName)
    const saved = await captured(page, 'POST', '/api/admin/products', () =>
      page.getByTestId('admin-product-save').click(),
    )
    const productId = ((await saved.response.json()) as { data: { id: string } }).data.id

    const correlation = {
      adjust: adjusted.response.headers()['x-correlation-id'] ?? '',
      replay: replay.headers()['x-correlation-id'] ?? '',
      cancel: cancelled.response.headers()['x-correlation-id'] ?? '',
      save: saved.response.headers()['x-correlation-id'] ?? '',
    }
    const answered = [adjusted.response, cancelled.response, saved.response].map((r) => r.status())
    expect(answered, 'the three commands answered').toEqual([200, 200, 201])

    // The API: each request's entry, by its correlation id, newest first.
    const listed = await activity(request, token)
    const entryOf = (id: string) => listed.find((e) => e.correlationId === id)
    const ours = {
      save: entryOf(correlation.save),
      cancel: entryOf(correlation.cancel),
      adjust: entryOf(correlation.adjust),
      replay: entryOf(correlation.replay),
    }
    expect(
      Object.entries(ours)
        .filter(([, e]) => e === undefined)
        .map(([k]) => k),
      'requests with no entry in GET /api/admin/activity',
    ).toEqual([])
    const { save, cancel, adjust, replayed } = {
      save: ours.save!,
      cancel: ours.cancel!,
      adjust: ours.adjust!,
      replayed: ours.replay!,
    }
    expect(
      [save, cancel, adjust].map((e) => listed.indexOf(e)),
      'newest first: the save, then the cancel, then the adjust',
    ).toEqual([save, cancel, adjust].map((e) => listed.indexOf(e)).sort((a, b) => a - b))
    for (const [entry, subject, status] of [
      [save, productId, answered[2]],
      [cancel, order.orderId, answered[1]],
      [adjust, stocked.variantId, answered[0]],
    ] as const) {
      expect([entry.actor.kind, entry.actor.id, entry.outcome], entry.command).toEqual([
        'admin',
        adminId,
        'applied',
      ])
      expect(
        entry.subjects.map((s) => s.id),
        entry.command,
      ).toContain(subject)
      expect(entry.responseStatus, entry.command).toBe(status)
    }
    expect(new Set([save.command, cancel.command, adjust.command]).size).toBe(3)
    expect([replayed.outcome, replayed.command, replayed.responseStatus]).toEqual([
      'replayed',
      adjust.command,
      adjust.responseStatus,
    ])
    expect(
      listed.filter((e) => 'responseBody' in e || 'response_body' in e).map((e) => e.id),
      'entries listing a stored response body',
    ).toEqual([])

    // The API filters.
    const byCommand = await activity(request, token, { command: cancel.command })
    const byCorrelation = await activity(request, token, { correlation: correlation.cancel })
    expect(byCommand.map((e) => e.command)).toEqual(byCommand.map(() => cancel.command))
    expect(byCommand.map((e) => e.id)).toContain(cancel.id)
    expect(byCorrelation.map((e) => e.id)).toEqual([cancel.id])

    // The page.
    await page.getByTestId('admin-nav-activity').click()
    await expect(page.getByTestId(`activity-row-${adjust.id}`)).toBeVisible({ timeout: 15_000 })
    const shown = await rowIds(page)
    const positions = [save.id, cancel.id, adjust.id].map((id) => shown.indexOf(id))
    expect(positions, `rows ${JSON.stringify(shown)}`).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.filter((p) => p < 0)).toEqual([])
    for (const entry of [save, cancel, adjust, replayed]) {
      const row = page.getByTestId(`activity-row-${entry.id}`)
      await expect(row).toContainText(entry.command)
      await expect(row).toContainText(entry.correlationId)
    }

    await filterBy(page, 'command', cancel.command)
    await expect(page.getByTestId(`activity-row-${save.id}`)).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByTestId(`activity-row-${cancel.id}`)).toBeVisible()
    const filtered = await rowIds(page)
    expect(
      filtered.filter((id) => !byCommand.some((e) => e.id === id)),
      'rows shown for another command',
    ).toEqual([])

    await page.goto('activity')
    await expect(page.getByTestId(`activity-row-${adjust.id}`)).toBeVisible({ timeout: 15_000 })
    await filterBy(page, 'subject', stocked.variantId)
    await expect(page.getByTestId(`activity-row-${cancel.id}`)).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByTestId(`activity-row-${adjust.id}`)).toBeVisible()
    await expect(page.getByTestId(`activity-row-${replayed.id}`)).toBeVisible()

    // The export.
    await page.goto('activity')
    await expect(page.getByTestId(`activity-row-${adjust.id}`)).toBeVisible({ timeout: 15_000 })
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('activity-export').click(),
    ])
    const text = await readFile((await download.path())!, 'utf8')
    const lines = text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Entry)
    for (const entry of [save, cancel, adjust, replayed]) {
      expect(
        lines.find((l) => l.id === entry.id),
        `export line for ${entry.command}`,
      ).toEqual(entry)
    }
    expect(EMAIL.exec(text)?.[0] ?? null, 'an email in the export').toBeNull()
    expect(
      [email, SHIPPING_ADDRESS.addressLine1, SHIPPING_ADDRESS.postalCode, ...cartCookies].filter(
        (secret) => text.includes(secret),
      ),
      'PII or a cart cookie value in the export',
    ).toEqual([])
  })
})
