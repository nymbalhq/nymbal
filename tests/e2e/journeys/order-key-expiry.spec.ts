import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Browser, Page, Request, TestInfo } from '@playwright/test'
import { linksIn, mailbox, type Mail, type Mailbox } from '../support/alerts'
import { isCustomProject, storeCapabilities } from '../support/capabilities'
import {
  adminToken,
  keyedOrderPath,
  openCheckout,
  orderKeyOf,
  orderNumberOf,
  ownProduct,
  walkToPayment,
} from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { expireOrderKeys } from '../support/order-keys'
import { formReady } from '../support/sign-in'

// An order's key stops opening it on its own (48 hours from checkout, 30 days from the email); keys are expired here by
// backdating their rows (support/order-keys.ts), the store's own clock untouched. Past expiry the keyed page asks for
// the order's email, which reaches the API only in a header, never in a page URL; the order page's not-found state
// offers "send me my order link", which answers the same whatever matched and, on the Mailpit store, mails a fresh
// link. A signed-in checkout lands on the account's order page with no key. Each new form submits once per click.

const ORDER_EMAIL_HEADER = 'x-nymbal-order-email'
const SHIPPING_LINE = '12 Checkout Row'

const email = (tag: string) => `e2e-expiry-${tag}-${randomUUID().slice(0, 8)}@nymbal.dev`

/** A browser with no cookies and no storage: the link opened somewhere else. */
async function freshBrowser(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const baseURL = testInfo.project.use.baseURL
  const context = await browser.newContext({ ...(baseURL !== undefined && { baseURL }) })
  return context.newPage()
}

/** A guest checkout in the browser, up to the keyed page it lands on. */
async function placeAsGuest(page: Page, request: APIRequestContext, buyer: string) {
  const product = await ownProduct(request, await adminToken(request), 5)
  await openCheckout(page, product)
  await walkToPayment(page, buyer)
  await page.getByTestId('place-order').click()
  await page.waitForURL(/\/order\//, { timeout: 20_000 })
  return { orderNumber: orderNumberOf(page), key: orderKeyOf(page) }
}

/** A paid guest order placed through the store's API, as a shopper's earlier visit left it. */
async function apiGuestOrder(request: APIRequestContext, buyer: string): Promise<string> {
  const product = await ownProduct(request, await adminToken(request), 5)
  const added = await request.post(`${API_URL}/api/cart/items`, {
    headers: await csrf(request),
    data: { variantId: product.variantId, qty: 1 },
  })
  expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)
  const address = {
    firstName: 'Expiry',
    lastName: 'Shopper',
    addressLine1: SHIPPING_LINE,
    city: 'Leeds',
    region: 'West Yorkshire',
    postalCode: 'LS1 4AP',
    country: 'GB',
  }
  const res = await request.post(`${API_URL}/api/checkout`, {
    headers: await csrf(request),
    data: { email: buyer, billingAddress: address, shippingAddress: address },
  })
  expect(res.ok(), `POST /api/checkout: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { orderNumber: string } }).data.orderNumber
}

/** Every URL the page's main frame has been at, from now on. */
function visited(page: Page): string[] {
  const urls: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url())
  })
  return urls
}

/** The URLs among `urls` that carry the email, as typed or encoded, or any `email` parameter. */
const carryingEmail = (urls: string[], address: string): string[] =>
  urls.filter((u) => {
    const url = new URL(u)
    return (
      url.searchParams.has('email') ||
      [address, encodeURIComponent(address)].some((v) => u.toLowerCase().includes(v.toLowerCase()))
    )
  })

/** The order page's prompt: the email typed in and submitted. */
async function submitEmail(page: Page, address: string): Promise<void> {
  await page.getByTestId('order-email-input').fill(address)
  await page.getByTestId('order-email-submit').click()
}

/** The order page's own not-found state, which offers "send me my order link". */
async function linkFormShown(page: Page): Promise<void> {
  await expect(
    page.getByTestId('order-link-number'),
    'the not-found state offers "send me my order link"',
  ).toBeVisible({ timeout: 15_000 })
}

/** The not-found state's "send me my order link", filled and submitted. */
async function requestLink(page: Page, orderNumber: string, address: string): Promise<void> {
  await linkFormShown(page)
  await page.getByTestId('order-link-number').fill(orderNumber)
  await page.getByTestId('order-link-email').fill(address)
  await page.getByTestId('order-link-submit').click()
}

const isOrderPlaced = (m: Mail, orderNumber: string): boolean =>
  m.subject === `Order ${orderNumber} confirmed`

async function confirmationsTo(mail: Mailbox, to: string, orderNumber: string): Promise<Mail[]> {
  return (await mail.messages(to)).filter((m) => isOrderPlaced(m, orderNumber))
}

/**
 * A form submission from the page, however a template sends it: a POST to the page itself (a form post, a Next
 * server action), the link request's POST, or a read that carries the email header.
 */
function isSubmission(r: Request, orderPath: string): boolean {
  const path = new URL(r.url()).pathname
  if (r.headers()[ORDER_EMAIL_HEADER] !== undefined) return true
  return r.method() === 'POST' && (path === orderPath || path === '/api/orders/link')
}

/**
 * Holds the page's first submission until `release`, so a second input lands on the form while the first is in flight,
 * and counts every submission the page sends.
 */
async function holdSubmissions(page: Page, orderPath: string) {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let count = 0
  await page.route('**/*', async (route) => {
    if (!isSubmission(route.request(), orderPath)) return route.fallback()
    count += 1
    await held
    await route.continue().catch(() => undefined)
  })
  return { count: () => count, release: () => release() }
}

/** Two clicks on the button: the second a double-click, sent once the first click's submission is out and held. */
async function doubleSubmit(page: Page, testId: string, sent: () => number): Promise<void> {
  const button = page.getByTestId(testId)
  const box = await button.boundingBox()
  if (box === null) throw new Error(`${testId}: the button has no box`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.click(x, y)
  await expect.poll(sent, { message: `${testId}: the first click submitted` }).toBe(1)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
}

test.describe('Order key lifetime', () => {
  // Kills: an expired key with no storefront path (the guest is locked out); a prompt that shows the order before the
  // email; an email that opens any order; the email carried in the page URL (a GET form), where logs and history keep
  // it.
  test('AC-7: checkout.order-key-expires: place-order lands on /order/<n>?key=<k> showing n; once its keys expire the same URL asks for the email and shows none of the order; another email shows the not-found state; the order’s email shows n; no URL the page was at carries the email', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const buyer = email('ac7')
    const { orderNumber, key } = await placeAsGuest(page, request, buyer)
    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })

    expect(
      await expireOrderKeys(orderNumber),
      `${orderNumber}: key rows expired`,
    ).toBeGreaterThanOrEqual(1)
    const urls = visited(page)
    await page.goto(keyedOrderPath(orderNumber, key))
    await expect(
      page.getByTestId('order-email-input'),
      'the expired key asks for the email',
    ).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-number')).toHaveCount(0)
    const prompt = await page.content()
    for (const secret of [buyer, SHIPPING_LINE])
      expect(prompt.includes(secret), `the prompt carries ${secret}`).toBe(false)

    const other = `other-${buyer}`
    await submitEmail(page, other)
    await expect(
      page.getByTestId('order-link-number'),
      'another email: the not-found state',
    ).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId('order-number')).toHaveCount(0)

    await page.goto(keyedOrderPath(orderNumber, key))
    await expect(page.getByTestId('order-email-input')).toBeVisible({ timeout: 15_000 })
    await submitEmail(page, buyer)
    await expect(page.getByTestId('order-number'), 'the order’s email').toHaveText(orderNumber, {
      timeout: 15_000,
    })
    await page.waitForLoadState('load')
    expect(carryingEmail([...urls, page.url()], buyer), 'URLs carrying the order’s email').toEqual(
      [],
    )
    expect(carryingEmail([...urls, page.url()], other), 'URLs carrying the other email').toEqual([])
  })

  // Kills: an account holder sent to a URL-borne key; a signed-in checkout that lands nowhere once it has no key.
  test('AC-7: a signed-in place-order lands on /account/orders/<n> with no key in the URL, showing n', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const shopper = { email: email('signed-in'), password: 'TestPassword123!' }
    await page.goto('/account/register')
    await formReady(page, 'nymbal-register-form')
    const form = page.getByTestId('register-form')
    await form.getByLabel('First Name', { exact: true }).fill('Ada')
    await form.getByLabel('Last Name', { exact: true }).fill('Expiry')
    await form.getByTestId('register-email').fill(shopper.email)
    const passwords = form.locator('input[type="password"]')
    for (let i = 0; i < (await passwords.count()); i += 1)
      await passwords.nth(i).fill(shopper.password)
    await form.locator('button[type="submit"]').click()
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
      timeout: 15_000,
    })

    const product = await ownProduct(request, await adminToken(request), 5)
    await openCheckout(page, product)
    await walkToPayment(page, shopper.email)
    await page.getByTestId('place-order').click()
    await page.waitForURL(/\/(account\/orders|order)\/[^/?#]+/, { timeout: 20_000 })
    const landed = new URL(page.url())
    const match = /^\/account\/orders\/([^/?#]+)$/.exec(landed.pathname)
    expect(landed.pathname, 'the signed-in checkout’s landing page').toMatch(
      /^\/account\/orders\/[^/]+$/,
    )
    expect(landed.searchParams.has('key'), `${landed.href} carries a key`).toBe(false)
    const orderNumber = decodeURIComponent(match![1]!)
    await expect(page.getByTestId('order-detail')).toContainText(orderNumber, { timeout: 15_000 })
  })

  // Kills: a link request that says whether the order matched; a link that is never mailed, or mailed for a wrong email;
  // a mailed link that does not open the order.
  test('AC-7: checkout.order-link-resend: /order/<n> with no key shows the not-found state with "send me my order link"; a wrong email and the order’s email each show order-link-sent; on the Mailpit store the order’s email alone brings one more confirmation, whose /order/<n>?key=<k> opens the order in a new browser @capabilities', async ({
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000)
    const delivering = isCustomProject(testInfo.project.name)
    expect((await storeCapabilities(request)).email.delivers, 'the store delivers mail').toBe(
      delivering,
    )
    const buyer = email('link')
    const orderNumber = await apiGuestOrder(request, buyer)
    const mail = delivering ? await mailbox() : null
    if (mail !== null) await mail.waitFor(buyer, 1)
    const earlier = mail === null ? [] : await confirmationsTo(mail, buyer, orderNumber)

    const page = await freshBrowser(browser, testInfo)
    try {
      const urls = visited(page)
      const wrong = `other-${buyer}`
      for (const address of [wrong, buyer]) {
        const res = await page.goto(`/order/${encodeURIComponent(orderNumber)}`)
        expect(res?.status(), `/order/${orderNumber} with no key`).toBe(404)
        await requestLink(page, orderNumber, address)
        await expect(
          page.getByTestId('order-link-sent'),
          `the link request for ${address}`,
        ).toBeVisible({
          timeout: 15_000,
        })
      }
      expect(
        carryingEmail([...urls, page.url()], buyer),
        'URLs carrying the order’s email',
      ).toEqual([])

      if (mail !== null) {
        await mail.waitFor(buyer, earlier.length + 1)
        const confirmations = await confirmationsTo(mail, buyer, orderNumber)
        expect(confirmations.length, 'confirmations after the two link requests').toBe(
          earlier.length + 1,
        )
        expect((await mail.messages(wrong)).length, 'mail to the wrong email').toBe(0)
        const fresh = confirmations.filter((m) => !earlier.some((e) => e.text === m.text))
        const links = linksIn(fresh[0]!).filter(
          (u) => u.pathname === `/order/${encodeURIComponent(orderNumber)}`,
        )
        expect(links.length, `order links in "${fresh[0]!.text}"`).toBe(1)
        const elsewhere = await freshBrowser(browser, testInfo)
        try {
          await elsewhere.goto(links[0]!.pathname + links[0]!.search)
          await expect(elsewhere.getByTestId('order-number')).toHaveText(orderNumber, {
            timeout: 15_000,
          })
        } finally {
          await elsewhere.context().close()
        }
      }
    } finally {
      await page.context().close()
    }
  })

  // Kills: the email prompt not disabled in flight, so a double-click sends the email twice.
  test('AC-9: standing.submit-once: on the expired keyed page, a click on order-email-submit and a double-click while its submission is held send one submission, and the order shows', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const buyer = email('once-prompt')
    const { orderNumber, key } = await placeAsGuest(page, request, buyer)
    await expireOrderKeys(orderNumber)
    await page.goto(keyedOrderPath(orderNumber, key))
    await page.waitForLoadState('load')
    await expect(page.getByTestId('order-email-input')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('order-email-input').fill(buyer)

    const orderPath = `/order/${encodeURIComponent(orderNumber)}`
    const submissions = await holdSubmissions(page, orderPath)
    await doubleSubmit(page, 'order-email-submit', submissions.count)
    submissions.release()

    await expect(page.getByTestId('order-number')).toHaveText(orderNumber, { timeout: 15_000 })
    await page.waitForLoadState('networkidle')
    expect(submissions.count(), 'submissions of the email prompt').toBe(1)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  // Kills: the link request not disabled in flight, so a double-click mails the shopper twice.
  test('AC-9: standing.submit-once: on the not-found state, a click on order-link-submit and a double-click while its submission is held send one submission and show order-link-sent; on the Mailpit store one confirmation follows @capabilities', async ({
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000)
    const delivering = isCustomProject(testInfo.project.name)
    expect((await storeCapabilities(request)).email.delivers, 'the store delivers mail').toBe(
      delivering,
    )
    const buyer = email('once-link')
    const orderNumber = await apiGuestOrder(request, buyer)
    const mail = delivering ? await mailbox() : null
    if (mail !== null) await mail.waitFor(buyer, 1)
    const earlier = mail === null ? 0 : (await confirmationsTo(mail, buyer, orderNumber)).length

    const page = await freshBrowser(browser, testInfo)
    try {
      const orderPath = `/order/${encodeURIComponent(orderNumber)}`
      await page.goto(orderPath)
      await page.waitForLoadState('load')
      await linkFormShown(page)
      await page.getByTestId('order-link-number').fill(orderNumber)
      await page.getByTestId('order-link-email').fill(buyer)

      const submissions = await holdSubmissions(page, orderPath)
      await doubleSubmit(page, 'order-link-submit', submissions.count)
      submissions.release()

      await expect(page.getByTestId('order-link-sent')).toBeVisible({ timeout: 15_000 })
      await page.waitForLoadState('networkidle')
      expect(submissions.count(), 'submissions of the link request').toBe(1)
      if (mail !== null) {
        await mail.waitFor(buyer, earlier + 1)
        expect(
          (await confirmationsTo(mail, buyer, orderNumber)).length,
          'confirmations after the request',
        ).toBe(earlier + 1)
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    } finally {
      await page.context().close()
    }
  })
})
