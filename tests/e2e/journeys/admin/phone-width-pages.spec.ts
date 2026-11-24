import { request as playwrightRequest, type Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { ADMIN_EMAIL, ADMIN_PASSWORD, placeOrder } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { phoneWidths } from '../../support/phone-width'
import { seedInsight } from '../../support/insights'
import { proposeProduct } from '../../support/proposals'

// At a phone's width no admin page is wider than the viewport: the pages admin/phone-width.spec.ts does not measure,
// each once it has rendered; the inbox with a pending proposal whose arguments hold one long value among them, and with an insight whose summary holds a long search term. Tagged @phone-width, so only the admin-mobile project runs it, at Pixel 7
// (tests/e2e/playwright.config.ts).

/** The right edge of an element against the viewport's width. */
async function rightEdge(page: Page, testId: string): Promise<{ right: number; viewport: number }> {
  const viewport = page.viewportSize()?.width ?? Number.POSITIVE_INFINITY
  const box = await page.getByTestId(testId).boundingBox()
  return { right: box === null ? Number.POSITIVE_INFINITY : box.x + box.width, viewport }
}

/** Holds the page the browser is on to the phone's width; soft, so one run measures every page. */
async function expectPhoneWidth(page: Page, name: string): Promise<void> {
  const { scrollWidth, innerWidth, viewport, measured } = await phoneWidths(page, name)
  expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewport + 1)
  expect.soft(innerWidth, measured).toBe(viewport)
}

test.describe('Admin at a phone’s width @phone-width', () => {
  test('sign-in, settings, activity and a missing page are each no wider than the viewport', async ({
    page,
    request,
  }) => {
    const main = page.locator('main')
    // Settings shows a row per field the listing carries, or its empty state when no slot takes keys from it.
    const listing = await request.get(`${API_URL}/api/admin/settings`, {
      headers: { authorization: `Bearer ${await adminToken(request)}` },
    })
    expect(listing.status()).toBe(200)
    const { slots } = ((await listing.json()) as { data: { slots: Array<{ fields: unknown[] }> } })
      .data
    const fields = slots.reduce((n, slot) => n + slot.fields.length, 0)

    const served = await page.goto('login')
    expect(served?.status(), `GET ${page.url()}: is the admin served here?`).toBe(200)
    await expect(page.getByTestId('admin-login-submit')).toBeVisible()
    await expectPhoneWidth(page, 'login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })

    const pages: Array<{ name: string; path: string; ready: () => Promise<void> }> = [
      {
        name: 'settings',
        path: 'settings',
        ready: () =>
          slots.length === 0
            ? expect(main.getByRole('heading', { name: 'Nothing to set here' })).toBeVisible()
            : expect(main.locator('[data-testid^="settings-field-"]')).toHaveCount(fields),
      },
      {
        name: 'activity',
        path: 'activity',
        ready: () => expect(page.getByTestId('activity-export')).toBeVisible(),
      },
      {
        name: 'not-found',
        path: 'no-such-page',
        ready: () => expect(main).toContainText('Page not found'),
      },
    ]

    for (const { name, path, ready } of pages) {
      await page.goto(path)
      await ready()
      // Skeletons are placeholders of fixed size; the page is measured once its data has replaced them.
      await expect(main.locator('.animate-pulse')).toHaveCount(0, { timeout: 10_000 })
      await expectPhoneWidth(page, name)
    }
  })

  test('AC-18: the inbox with a pending proposal whose arguments hold an unbroken 160-character value is no wider than the viewport, and its row and its Approve and Reject buttons end inside it', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request)
    const proposal = await proposeProduct(request, token, `long-argument-${'x'.repeat(146)}`)
    const ids = [
      `admin-inbox-row-${proposal.id}`,
      `admin-inbox-approve-${proposal.id}`,
      `admin-inbox-reject-${proposal.id}`,
    ]

    // Through the form, as above: signInAsAdmin waits for a sidebar link the phone's off-canvas sidebar hides.
    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })
    await page.goto('inbox')
    await expect(page.getByTestId(ids[0]!)).toContainText(proposal.slug, { timeout: 15_000 })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })

    await expectPhoneWidth(page, 'inbox')
    for (const id of ids) {
      const { right, viewport } = await rightEdge(page, id)
      expect
        .soft(right, `${id}: right edge ${right}, viewport ${viewport}`)
        .toBeLessThanOrEqual(viewport + 1)
    }
  })

  test('AC-14: the inbox with an open insight whose summary holds an unbroken 100-character search term is no wider than the viewport, and its card and its Dismiss end inside it', async ({
    page,
  }) => {
    const term = `${'t'.repeat(99)}x`
    const summary = `"${term}" was searched 4 times yesterday and found nothing.`
    const id = await seedInsight({
      severity: 'info',
      summary,
      day: new Date().toISOString().slice(0, 10),
      job: 'zero-result-term',
    })
    const ids = [`admin-inbox-insight-${id}`, `admin-inbox-dismiss-${id}`]

    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })
    await page.goto('inbox')
    await expect(page.getByTestId(ids[0]!)).toContainText(term, { timeout: 15_000 })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })

    await expectPhoneWidth(page, 'inbox-brief')
    for (const testId of ids) {
      const { right, viewport } = await rightEdge(page, testId)
      expect
        .soft(right, `${testId}: right edge ${right}, viewport ${viewport}`)
        .toBeLessThanOrEqual(viewport + 1)
    }
  })

  test('AC-11: the Reports page, with a currency section and its daily table rendered, is no wider than the viewport, the section ends inside it, and a table wider than its card scrolls inside the card', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const guest = await playwrightRequest.newContext()
    let orderNumber: string
    try {
      orderNumber = (
        await placeOrder(
          guest,
          `e2e-reports-phone-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
        )
      ).orderNumber
    } finally {
      await guest.dispose()
    }
    const auth = { headers: { authorization: `Bearer ${token}` } }
    const order = await request.get(
      `${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`,
      auth,
    )
    expect(order.status(), await order.text()).toBe(200)
    const currency = ((await order.json()) as { data: { currency: string } }).data.currency
    const series = await request.get(`${API_URL}/api/admin/reports?grain=day`, auth)
    expect(series.status(), await series.text()).toBe(200)
    const today = ((await series.json()) as { data: { window: { to: string } } }).data.window.to
    const section = `admin-reports-currency-${currency}`
    const todayRow = `admin-reports-day-${currency}-${today}`

    await page.goto('login')
    await page.getByTestId('admin-login-email').fill(ADMIN_EMAIL)
    await page.getByTestId('admin-login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('admin-login-submit').click()
    await page.waitForURL((url) => !url.pathname.replace(/\/$/, '').endsWith('/login'), {
      timeout: 15_000,
    })
    // The order reaches the report once the relay delivers it.
    await expect(async () => {
      await page.goto('reports')
      await expect(page.getByTestId(todayRow)).toHaveAttribute('data-partial', 'true', {
        timeout: 5_000,
      })
    }).toPass({ timeout: 60_000 })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })

    await expectPhoneWidth(page, 'reports')
    const { right, viewport } = await rightEdge(page, section)
    expect
      .soft(right, `${section}: right edge ${right}, viewport ${viewport}`)
      .toBeLessThanOrEqual(viewport + 1)

    // The daily table fits its card, or an element between them scrolls it; a card that hides the overflow clips it.
    const table = await page.getByTestId(todayRow).evaluate((row, sectionId) => {
      const card = row.closest(`[data-testid="${sectionId}"]`)
      const body = row.closest('table') ?? row.parentElement
      if (card === null || body === null) return { width: -1, card: -1, scroller: false }
      let scroller = false
      for (
        let el = body.parentElement;
        el !== null && el !== card.parentElement;
        el = el.parentElement
      ) {
        const overflow = getComputedStyle(el).overflowX
        if ((overflow === 'auto' || overflow === 'scroll') && el.clientWidth <= card.clientWidth) {
          scroller = true
          break
        }
      }
      return { width: body.scrollWidth, card: card.clientWidth, scroller }
    }, section)
    expect(table.card, `the day row inside ${section}`).toBeGreaterThan(0)
    expect(
      table.width <= table.card || table.scroller,
      `daily table ${table.width} px in a ${table.card} px card, scrolls inside it: ${table.scroller}`,
    ).toBe(true)
  })
})
