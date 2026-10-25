import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page, TestInfo } from '@playwright/test'
import {
  adjustStock,
  confirmThroughApi,
  customStoreEvents,
  isBackInStock,
  isConfirmation,
  isPriceDrop,
  linkTo,
  mailbox,
  subscribeThroughApi,
  type Mail,
  type Mailbox,
} from '../support/alerts'
import { signInAsAdmin } from '../support/admin'
import { isCustomProject, storeCapabilities, type StoreCapabilities } from '../support/capabilities'
import { adminToken, ownProduct, type OwnProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { upgraded } from '../support/server-rendered'

// Back-in-stock and price-drop alerts on both templates. Each journey reads GET /api/capabilities and asserts the
// branch it reports (@capabilities): on the native store, whose email only logs, there is no form and subscribe is
// refused; on the custom-providers store, whose email is SMTP into Mailpit, a shopper subscribes from the product page,
// confirms from the email, and is mailed once when the variant comes back, or when the admin lowers its price below
// the last price the subscription was told. State moves only through the product's own routes: the admin stock
// adjustment, the admin's product page, and the links in the mail.

const TAG = 'nymbal-notify-me'

/** Whether the report says the store's email delivers; a report without the field reads as no answer. */
function delivers(caps: StoreCapabilities): unknown {
  return (caps as { email?: { delivers?: unknown } }).email?.delivers
}

function storefrontOrigin(testInfo: TestInfo): string {
  const base = testInfo.project.use.baseURL
  if (base === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
  return new URL(base).origin
}

const address = (role: string, tag: string): string => `alerts-${role}-${tag}@nymbal.dev`

/** The forms the hydrated product page shows inside its notify-me hosts. */
async function formsShown(page: Page): Promise<string[]> {
  return page
    .locator(TAG)
    .getByTestId('notify-me')
    .evaluateAll((forms) => forms.map((f) => f.getAttribute('data-kind') ?? ''))
}

/** Waits for the page's own hydration of its notify-me hosts, when it has any. */
async function hydrated(page: Page): Promise<void> {
  await page.waitForLoadState('load')
  if ((await page.locator(TAG).count()) > 0) await upgraded(page, [TAG])
}

async function subscribeFromPage(page: Page, product: OwnProduct, email: string): Promise<void> {
  await page.goto(`/product/${product.slug}`)
  await hydrated(page)
  await page.locator(TAG).getByTestId('notify-me-email').fill(email)
  await page.locator(TAG).getByTestId('notify-me-submit').click()
  await expect(page.locator(TAG).getByTestId('notify-me-notice')).toHaveText(
    'Check your inbox to confirm.',
  )
}

/** The newest confirmation to an address, read from Mailpit once `count` messages have reached it. */
async function confirmation(mail: Mailbox, to: string, count = 1) {
  const found = (await mail.waitFor(to, count)).filter(isConfirmation)
  expect(found.length, `confirmations to ${to}`).toBeGreaterThan(0)
  return found.at(-1)!
}

/** Subscribed and confirmed through the API, as the positive control's browser and storefront server would. */
async function confirmedThroughApi(
  request: APIRequestContext,
  mail: Mailbox,
  origin: string,
  email: string,
  product: OwnProduct,
  kind: 'back_in_stock' | 'price_drop' = 'back_in_stock',
): Promise<void> {
  const sub = await subscribeThroughApi(request, origin, email, product.variantId, kind)
  expect(sub.status, sub.text).toBe(202)
  const token = linkTo(await confirmation(mail, email), '/alerts/confirm').searchParams.get('token')
  const answer = await confirmThroughApi(request, token ?? '')
  expect(answer.status, answer.text).toBe(200)
}

async function alertsTo(mail: Mailbox, to: string, slug: string) {
  return (await mail.messages(to)).filter((m) => isBackInStock(m, slug))
}

async function priceDropsTo(mail: Mailbox, to: string, slug: string): Promise<Mail[]> {
  return (await mail.messages(to)).filter((m) => isPriceDrop(m, slug))
}

/** The admin the custom API serves, one origin with that API. */
const ADMIN_BASE = `${API_URL}/admin/`

const pounds = (minor: number): string => `£${(minor / 100).toFixed(2)}`

/**
 * Opens the product in the admin's product page, sets the variant's price on the Variants tab (pressing Add Variant
 * first when asked) and saves; answers the save's PATCH status and echoed correlation id.
 */
async function saveAdminPrice(
  admin: Page,
  product: OwnProduct,
  priceMinor: number,
  opts: { addRow?: boolean } = {},
): Promise<{ status: number; correlationId: string }> {
  await admin.goto(new URL(`products/${product.slug}`, ADMIN_BASE).href)
  await admin.getByTestId('admin-product-tab-variants').click()
  if (opts.addRow === true) await admin.getByRole('button', { name: /Add Variant/ }).click()
  await admin
    .getByTestId(`admin-product-variant-price-${product.variantId}`)
    .fill((priceMinor / 100).toFixed(2))
  const saved = admin.waitForResponse(
    (res) =>
      res.request().method() === 'PATCH' &&
      new URL(res.url()).pathname.startsWith('/api/admin/products/'),
  )
  await admin.getByTestId('admin-product-save').click()
  const res = await saved
  return { status: res.status(), correlationId: res.headers()['x-correlation-id'] ?? '' }
}

/** The variant's price as `GET /api/products/:slug` serves it. */
async function servedPrice(request: APIRequestContext, product: OwnProduct): Promise<number> {
  const res = await request.get(`${API_URL}/api/products/${product.slug}`)
  const body = (await res.json()) as {
    data: { variants: Array<{ id: string; priceMinor: number }> }
  }
  return body.data.variants.find((v) => v.id === product.variantId)!.priceMinor
}

test.describe('back-in-stock alerts', () => {
  test('AC-9: an out-of-stock product page carries the notify-me form in its server HTML and once hydrated exactly when the store reports email.delivers, and after a restock and reload it shows the price-drop form there instead @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)

    const token = await adminToken(request)
    const product = await ownProduct(request, token, 0)
    const html = await (
      await request.get(new URL(`/product/${product.slug}`, storefrontOrigin(testInfo)).href)
    ).text()
    const served = {
      host: new RegExp(`<${TAG}\\b`).test(html),
      form: /data-testid="notify-me"[^>]*data-kind="back_in_stock"|data-kind="back_in_stock"[^>]*data-testid="notify-me"/.test(
        html,
      ),
    }
    expect(served, 'the server HTML').toEqual({ host: delivering, form: delivering })

    await page.goto(`/product/${product.slug}`)
    await hydrated(page)
    expect(await formsShown(page), 'the hydrated page').toEqual(delivering ? ['back_in_stock'] : [])
    if (!delivering) expect(await page.locator(TAG).count()).toBe(0)

    await adjustStock(request, token, product.variantId, 3, `alerts-ac9-${randomUUID()}`)
    await page.reload()
    await hydrated(page)
    await expect
      .poll(() => formsShown(page), { timeout: 15_000 })
      .toEqual(delivering ? ['price_drop'] : [])
  })

  test('AC-10: on the Mailpit store, a confirmed subscriber is mailed once when the variant comes back, at the storefront’s origin; an unsubscribed one and an unconfirmed address are not; a second restock mails only the newly confirmed; the log has the restock; a registered address answers as a fresh one @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const origin = storefrontOrigin(testInfo)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 0)
    const tag = randomUUID().slice(0, 8)

    if (!delivering) {
      const refused = await subscribeThroughApi(
        request,
        origin,
        address('native', tag),
        product.variantId,
      )
      expect([
        refused.status,
        (JSON.parse(refused.text) as { error?: { code?: string } }).error?.code,
      ]).toEqual([409, 'alerts.unavailable'])
      return
    }

    const mail = await mailbox()
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((role) => address(role, tag)) as [
      string,
      string,
      string,
      string,
    ]

    // A through the product page; its confirm link is at this storefront and confirms.
    await subscribeFromPage(page, product, a)
    const aConfirm = linkTo(await confirmation(mail, a), '/alerts/confirm')
    expect(aConfirm.origin).toBe(origin)
    await page.goto(aConfirm.href)
    await expect(
      page.getByTestId('alert-confirmed').locator(`a[href$="/product/${product.slug}"]`),
    ).toHaveCount(1)

    // B, the positive control, through the API with the storefront's Origin.
    await confirmedThroughApi(request, mail, origin, b, product)

    // C confirms, then follows the confirmation's unsubscribe link.
    const cSub = await subscribeThroughApi(request, origin, c, product.variantId)
    expect(cSub.status, cSub.text).toBe(202)
    const cMail = await confirmation(mail, c)
    await page.goto(linkTo(cMail, '/alerts/confirm').href)
    await expect(page.getByTestId('alert-confirmed')).toHaveCount(1)
    await page.goto(linkTo(cMail, '/alerts/unsubscribe').href)
    await expect(page.getByTestId('alert-unsubscribed')).toHaveCount(1)

    const first = `alerts-ac10-${randomUUID()}`
    await adjustStock(request, token, product.variantId, 2, first)

    await mail.waitFor(a, 2)
    await mail.waitFor(b, 2)
    const productUrl = `${origin}/product/${product.slug}`
    for (const who of [a, b]) {
      const alerts = await alertsTo(mail, who, product.slug)
      expect(alerts.length, `back-in-stock emails to ${who}`).toBe(1)
      expect(linkTo(alerts[0]!, `/product/${product.slug}`).href).toBe(productUrl)
      expect(linkTo(alerts[0]!, '/alerts/unsubscribe').origin).toBe(origin)
    }
    expect(await alertsTo(mail, c, product.slug)).toEqual([])

    const logged = await customStoreEvents(first, 'product.*')
    expect(
      logged
        .filter((e) => e.type === 'product.restocked.v1')
        .map((e) => [e.payload?.['variantId'], e.payload?.['previousQty']]),
    ).toEqual([[product.variantId, 0]])

    const [aAlert] = await alertsTo(mail, a, product.slug)
    await page.goto(linkTo(aAlert!, '/alerts/unsubscribe').href)
    await expect(page.getByTestId('alert-unsubscribed')).toHaveCount(1)

    // A sell-out and a second restock: only D, confirmed after the first, is mailed, and only then are the others read.
    await adjustStock(request, token, product.variantId, -2, `alerts-ac10-${randomUUID()}`)
    await confirmedThroughApi(request, mail, origin, d, product)
    await adjustStock(request, token, product.variantId, 1, `alerts-ac10-${randomUUID()}`)
    await mail.waitFor(d, 2)
    const counts = async (who: string[]) =>
      Promise.all(who.map(async (w) => (await alertsTo(mail, w, product.slug)).length))
    expect(await counts([d, a, b, c])).toEqual([1, 1, 1, 0])

    // A registered shopper's address and a fresh one get the same answer.
    const registered = address('registered', tag)
    const reg = await request.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(request),
      data: { email: registered, password: 'Correct-horse-42!' },
    })
    expect(reg.ok(), `register: ${await reg.text()}`).toBe(true)
    const answers = [
      await subscribeThroughApi(request, origin, registered, product.variantId),
      await subscribeThroughApi(request, origin, address('fresh', tag), product.variantId),
    ]
    expect(answers[1]).toEqual(answers[0])
    expect(answers[0]!.status).toBe(202)
  })

  test('AC-11: a double-click on notify-me-submit, and Enter then a click, each send one subscribe and put one confirmation in Mailpit @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 0)

    if (!delivering) {
      await page.goto(`/product/${product.slug}`)
      await hydrated(page)
      expect(await page.locator(TAG).count()).toBe(0)
      return
    }

    const mail = await mailbox()
    const tag = randomUUID().slice(0, 8)
    const posted: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/alerts/subscribe') {
        posted.push(String((req.postDataJSON() as { email?: string } | null)?.email ?? ''))
      }
    })

    const twice = address('dblclick', tag)
    await page.goto(`/product/${product.slug}`)
    await hydrated(page)
    await page.locator(TAG).getByTestId('notify-me-email').fill(twice)
    await page.locator(TAG).getByTestId('notify-me-submit').dblclick()
    await expect(page.locator(TAG).getByTestId('notify-me-notice')).toHaveText(
      'Check your inbox to confirm.',
    )

    const entered = address('enter', tag)
    await page.goto(`/product/${product.slug}`)
    await hydrated(page)
    const field = page.locator(TAG).getByTestId('notify-me-email')
    await field.fill(entered)
    await field.press('Enter')
    await page.locator(TAG).getByTestId('notify-me-submit').click({ force: true })
    await expect(page.locator(TAG).getByTestId('notify-me-notice')).toHaveText(
      'Check your inbox to confirm.',
    )

    // A marker's confirmation, sent after both, has arrived: any second confirmation to either would be there too.
    const marker = address('marker', tag)
    const sub = await subscribeThroughApi(
      request,
      storefrontOrigin(testInfo),
      marker,
      product.variantId,
    )
    expect(sub.status, sub.text).toBe(202)
    await mail.waitFor(marker, 1)

    expect([twice, entered].map((who) => posted.filter((e) => e === who).length)).toEqual([1, 1])
    const confirmations = await Promise.all(
      [twice, entered].map(async (who) => (await mail.messages(who)).filter(isConfirmation).length),
    )
    expect(confirmations).toEqual([1, 1])
  })
})

test.describe('price-drop alerts', () => {
  test('AC-6: on the Mailpit store, a price lowered in the admin’s product page (after Add Variant) saves, is served and logged with both prices, and mails each confirmed price-drop subscriber once naming both prices; the confirmation and confirm page name the price drop, never back in stock; an unsubscribed address, a rise and a return to the last alerted price mail nothing @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(240_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)

    if (!delivering) {
      await page.goto(`/product/${product.slug}`)
      await hydrated(page)
      expect(await formsShown(page)).toEqual([])
      expect(await page.locator(TAG).count()).toBe(0)
      return
    }

    const origin = storefrontOrigin(testInfo)
    const mail = await mailbox()
    const tag = randomUUID().slice(0, 8)
    const [a, b] = ['pd-a', 'pd-b'].map((role) => address(role, tag)) as [string, string]
    const start = await servedPrice(request, product)

    // A through the in-stock product page's price-drop form.
    await page.goto(`/product/${product.slug}`)
    await hydrated(page)
    expect(await formsShown(page), 'the in-stock product page').toEqual(['price_drop'])
    await subscribeFromPage(page, product, a)
    const aConfirmation = await confirmation(mail, a)
    expect(`${aConfirmation.subject}\n${aConfirmation.text}`).toMatch(/price/i)
    expect(`${aConfirmation.subject}\n${aConfirmation.text}`).not.toMatch(/back in stock/i)
    await page.goto(linkTo(aConfirmation, '/alerts/confirm').href)
    const confirmed = page.getByTestId('alert-confirmed')
    await expect(confirmed).toHaveAttribute('data-kind', 'price_drop')
    await expect(confirmed).toContainText(`the price of ${product.name} drops`)
    await expect(confirmed).not.toContainText(/back in stock/i)

    // B, the control, through the API.
    await confirmedThroughApi(request, mail, origin, b, product, 'price_drop')

    // The admin on the custom API: a row added, the existing variant's price lowered, saved.
    const admin = await page.context().newPage()
    await signInAsAdmin(admin, ADMIN_BASE)
    const lower = start - 400
    const first = await saveAdminPrice(admin, product, lower, { addRow: true })
    expect(first.status, 'the save’s PATCH').toBe(200)

    await mail.waitFor(a, 2)
    await mail.waitFor(b, 2)
    for (const who of [a, b]) {
      const drops = await priceDropsTo(mail, who, product.slug)
      expect(drops.length, `price-drop emails to ${who}`).toBe(1)
      expect(drops[0]!.text).toContain(pounds(start))
      expect(drops[0]!.text).toContain(pounds(lower))
      expect(`${drops[0]!.subject}\n${drops[0]!.text}`).not.toMatch(/back in stock/i)
      expect(linkTo(drops[0]!, `/product/${product.slug}`).origin).toBe(origin)
    }

    await admin.goto(new URL(`products/${product.slug}`, ADMIN_BASE).href)
    await admin.getByTestId('admin-product-tab-variants').click()
    await expect(admin.getByTestId(`admin-product-variant-price-${product.variantId}`)).toHaveValue(
      (lower / 100).toFixed(2),
    )
    expect(await servedPrice(request, product), 'the storefront API').toBe(lower)

    const logged = await customStoreEvents(first.correlationId, 'product.*')
    expect(
      logged
        .filter((e) => e.type === 'product.variant_price_changed.v1')
        .map((e) => [
          e.payload?.['variantId'],
          e.payload?.['previousPriceMinor'],
          e.payload?.['priceMinor'],
        ]),
    ).toEqual([[product.variantId, start, lower]])

    const [aAlert] = await priceDropsTo(mail, a, product.slug)
    await page.goto(linkTo(aAlert!, '/alerts/unsubscribe').href)
    await expect(page.getByTestId('alert-unsubscribed')).toHaveCount(1)

    // A second, lower price: B is mailed, and only then is A's mailbox read.
    const second = lower - 300
    expect((await saveAdminPrice(admin, product, second)).status).toBe(200)
    await mail.waitFor(b, 3)
    expect((await priceDropsTo(mail, a, product.slug)).length, 'alerts to the unsubscribed A').toBe(
      1,
    )

    // A rise, then back to B's last alerted price: nothing; read after a third, lower price mails B.
    const raised = second + 200
    expect((await saveAdminPrice(admin, product, raised)).status).toBe(200)
    expect((await saveAdminPrice(admin, product, second)).status).toBe(200)
    const third = second - 100
    expect((await saveAdminPrice(admin, product, third)).status).toBe(200)
    await mail.waitFor(b, 4)
    const toB = await priceDropsTo(mail, b, product.slug)
    expect(toB.length, 'price-drop emails to B').toBe(3)
    expect(
      toB.filter((m) => m.text.includes(pounds(raised))),
      'an alert about the rise',
    ).toEqual([])
    expect(toB.filter((m) => m.text.includes(pounds(third))).length).toBe(1)
    await admin.close()
  })

  test('AC-7: in the price-drop state, a double-click on notify-me-submit, and Enter then a click, each send one subscribe and put one confirmation in Mailpit @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const token = await adminToken(request)
    const product = await ownProduct(request, token, 5)

    if (!delivering) {
      await page.goto(`/product/${product.slug}`)
      await hydrated(page)
      expect(await page.locator(TAG).count()).toBe(0)
      return
    }

    const mail = await mailbox()
    const tag = randomUUID().slice(0, 8)
    const posted: Array<{ email: string; kind: string }> = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/alerts/subscribe') {
        const body = req.postDataJSON() as { email?: string; kind?: string } | null
        posted.push({ email: String(body?.email ?? ''), kind: String(body?.kind ?? '') })
      }
    })

    const twice = address('pd-dblclick', tag)
    await page.goto(`/product/${product.slug}`)
    await hydrated(page)
    expect(await formsShown(page), 'the in-stock product page').toEqual(['price_drop'])
    await page.locator(TAG).getByTestId('notify-me-email').fill(twice)
    await page.locator(TAG).getByTestId('notify-me-submit').dblclick()
    await expect(page.locator(TAG).getByTestId('notify-me-notice')).toHaveText(
      'Check your inbox to confirm.',
    )

    const entered = address('pd-enter', tag)
    await page.goto(`/product/${product.slug}`)
    await hydrated(page)
    const field = page.locator(TAG).getByTestId('notify-me-email')
    await field.fill(entered)
    await field.press('Enter')
    await page.locator(TAG).getByTestId('notify-me-submit').click({ force: true })
    await expect(page.locator(TAG).getByTestId('notify-me-notice')).toHaveText(
      'Check your inbox to confirm.',
    )

    // A marker's confirmation, sent after both, has arrived: any second confirmation to either would be there too.
    const marker = address('pd-marker', tag)
    const sub = await subscribeThroughApi(
      request,
      storefrontOrigin(testInfo),
      marker,
      product.variantId,
      'price_drop',
    )
    expect(sub.status, sub.text).toBe(202)
    await mail.waitFor(marker, 1)

    expect(
      [twice, entered].map((who) => posted.filter((p) => p.email === who).map((p) => p.kind)),
    ).toEqual([['price_drop'], ['price_drop']])
    const confirmations = await Promise.all(
      [twice, entered].map(async (who) => (await mail.messages(who)).filter(isConfirmation).length),
    )
    expect(confirmations).toEqual([1, 1])
  })
})
