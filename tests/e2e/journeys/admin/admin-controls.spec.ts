import {
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
  type Response,
} from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { placeOrder, realtimeConnected, signInAsAdmin, watchRealtime } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The products row menu and the sidebar's pending orders badge against the real store: the menu shows without hover
// and its Duplicate and Archive change what the admin API serves; the badge follows the page's own count fetches.

interface ApiProduct {
  id: string
  slug: string
  name: string
  status: string
  variants: Array<{ id: string; sku: string; stock: number }>
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function ownProduct(request: APIRequestContext, token: string): Promise<ApiProduct> {
  const tag = randomUUID().slice(0, 8)
  const res = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), ...auth(token) },
    data: {
      slug: `row-menu-${tag}`,
      name: `Row Menu ${tag}`,
      description: 'A product of one row menu journey.',
      status: 'active',
      variants: [
        { sku: `ROWMENU-${tag}-S`, name: 'Small', priceMinor: 1500, stock: 6, options: [] },
        { sku: `ROWMENU-${tag}-L`, name: 'Large', priceMinor: 1800, stock: 3, options: [] },
      ],
    },
  })
  expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
  return ((await res.json()) as { data: ApiProduct }).data
}

async function productsNamed(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<ApiProduct[]> {
  const res = await request.get(
    `${API_URL}/api/admin/products?q=${encodeURIComponent(name)}&limit=100`,
    { headers: auth(token) },
  )
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { data: ApiProduct[] }).data
}

const stockOf = (p: ApiProduct) => p.variants.map((v) => ({ sku: v.sku, stock: v.stock }))

async function choose(page: Page, action: 'duplicate' | 'archive', productId: string) {
  await page.getByTestId(`admin-products-row-actions-${productId}`).click()
  const write = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/admin/products/${productId}/${action}`,
  )
  await page.getByTestId(`admin-products-row-${action}-${productId}`).click()
  return write
}

async function statusCell(page: Page, productId: string) {
  const headers = (await page.getByRole('columnheader').allTextContents()).map((h) => h.trim())
  const column = headers.indexOf('Status')
  expect(column, `the Status column in ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0)
  return page.getByTestId(`admin-products-row-${productId}`).getByRole('cell').nth(column)
}

/** Every answer to the badge's own count GET, in arrival order, with its `meta.total`. */
function watchPendingCounts(page: Page): Array<Promise<number>> {
  const answers: Array<Promise<number>> = []
  page.on('response', (r: Response) => {
    const url = new URL(r.url())
    if (
      r.request().method() === 'GET' &&
      url.pathname === '/api/admin/orders' &&
      url.searchParams.get('status') === 'pending' &&
      url.searchParams.get('limit') === '1'
    ) {
      answers.push(r.json().then((body) => (body as { meta: { total: number } }).meta.total))
    }
  })
  return answers
}

const badgeText = (total: number) => (total > 99 ? '99+' : String(total))

/**
 * Waits for a count answer after `from`, then until the Orders link's name and the badge agree with the latest answer
 * in one look (another journey's order may bring a newer one), and returns that total.
 */
async function agreesWithLatestCount(
  page: Page,
  answers: Array<Promise<number>>,
  from: number,
  atLeast = 0,
): Promise<number> {
  let latest = -1
  await expect
    .poll(
      async () => {
        if (answers.length <= from) return 'no count fetched since the act'
        latest = await answers.at(-1)!
        if (latest < atLeast) return `latest total ${latest} below ${atLeast}`
        const named = page
          .getByTestId('admin-nav-orders')
          .and(page.getByRole('link', { name: new RegExp(`\\b${latest} pending\\b`) }))
        if ((await named.count()) !== 1) return `the Orders link not named "${latest} pending"`
        const badge = await page.getByTestId('admin-orders-pending-count').allTextContents()
        return JSON.stringify(badge) === JSON.stringify([badgeText(latest)])
          ? 'agrees'
          : `badge ${JSON.stringify(badge)} for total ${latest}`
      },
      { timeout: 20_000 },
    )
    .toBe('agrees')
  return latest
}

test.describe('The products row menu', () => {
  test('AC-8: the row trigger shows at rest at 1280 and 390 wide and when reached by Tab; Duplicate twice makes two drafts -copy and -copy-2 with no stock, the original unchanged; Archive reads archived as the API says', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const original = await ownProduct(request, token)
    const stockBefore = stockOf(original)

    await page.setViewportSize({ width: 1280, height: 800 })
    await signInAsAdmin(page)
    await page.goto('products')
    const search = page.getByPlaceholder('Search products...')
    await search.fill(original.name)
    const trigger = page.getByTestId(`admin-products-row-actions-${original.id}`)
    await expect(page.getByTestId(`admin-products-row-${original.id}`)).toBeVisible({
      timeout: 15_000,
    })

    await page.mouse.move(0, 0)
    await expect(trigger).toHaveCSS('opacity', '1')

    await search.focus()
    for (let presses = 0; presses < 12; presses += 1) {
      if (await trigger.evaluate((el) => el === document.activeElement)) break
      await page.keyboard.press('Tab')
    }
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS('opacity', '1')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.mouse.move(0, 0)
    await expect(trigger).toHaveCSS('opacity', '1')
    await page.setViewportSize({ width: 1280, height: 800 })

    const result = page.getByTestId('admin-products-row-result')
    for (let k = 1; k <= 2; k += 1) {
      const answer = await choose(page, 'duplicate', original.id)
      expect(answer.status(), `duplicate ${k}: ${await answer.text()}`).toBe(201)
      await expect(result).toContainText(`Duplicated as ${original.name} (Copy)`)
    }

    await expect
      .poll(async () => (await productsNamed(request, token, original.name)).length, {
        timeout: 10_000,
      })
      .toBe(3)
    const listed = await productsNamed(request, token, original.name)
    const copies = listed.filter((p) => p.id !== original.id)
    expect(copies.map((c) => c.slug).sort()).toEqual([
      `${original.slug}-copy`,
      `${original.slug}-copy-2`,
    ])
    expect(copies.map((c) => c.status)).toEqual(copies.map(() => 'draft'))
    expect(copies.flatMap((c) => c.variants.map((v) => v.stock))).toEqual(
      copies.flatMap((c) => c.variants.map(() => 0)),
    )
    expect(stockOf(listed.find((p) => p.id === original.id)!), 'the original stock').toEqual(
      stockBefore,
    )
    for (const copy of copies) {
      await expect(page.getByTestId(`admin-products-row-${copy.id}`)).toBeVisible()
    }
    await expect(page.locator('tbody tr')).toHaveCount(listed.length)

    const archived = await choose(page, 'archive', original.id)
    expect(archived.status(), await archived.text()).toBe(200)
    await expect(result).toContainText(`Archived ${original.name}`)
    await expect(await statusCell(page, original.id)).toHaveText(/^\s*archived\s*$/i)
    const read = await request.get(`${API_URL}/api/admin/products/${original.id}`, {
      headers: auth(token),
    })
    expect(read.ok(), await read.text()).toBe(true)
    expect(((await read.json()) as { data: ApiProduct }).data.status).toBe('archived')
  })
})

test.describe('The pending orders badge', () => {
  test('AC-9: two orders placed elsewhere, then one paid, each bring a count fetch by the page with no reload, and the Orders link reads "<total> pending" for that fetch\'s total', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const answers = watchPendingCounts(page)
    await watchRealtime(page)
    await signInAsAdmin(page)
    await realtimeConnected(page)
    await expect.poll(() => answers.length, { timeout: 15_000 }).toBeGreaterThan(0)
    await answers.at(-1)
    await page.evaluate(() => {
      ;(window as unknown as { __sameDocument?: string }).__sameDocument = 'loaded once'
    })

    const beforePlacing = answers.length
    const placed: Array<{ orderId: string }> = []
    for (let i = 0; i < 2; i += 1) {
      const shopper = await playwrightRequest.newContext()
      try {
        placed.push(await placeOrder(shopper))
      } finally {
        await shopper.dispose()
      }
    }
    const afterPlacing = await agreesWithLatestCount(page, answers, beforePlacing, 2)
    expect(afterPlacing).toBeGreaterThanOrEqual(2)

    const beforePaying = answers.length
    const admin = await playwrightRequest.newContext()
    try {
      const token = await adminToken(admin)
      const paid = await admin.post(`${API_URL}/api/admin/orders/${placed[0]!.orderId}/mark-paid`, {
        headers: { ...(await csrf(admin)), ...auth(token) },
        data: {},
      })
      expect(paid.status(), await paid.text()).toBe(200)
    } finally {
      await admin.dispose()
    }
    await agreesWithLatestCount(page, answers, beforePaying)

    expect(
      await page.evaluate(
        () => (window as unknown as { __sameDocument?: string }).__sameDocument ?? 'reloaded',
      ),
    ).toBe('loaded once')
  })
})
