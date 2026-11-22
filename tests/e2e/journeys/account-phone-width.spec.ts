import { randomUUID } from 'node:crypto'
import { devices } from '@playwright/test'
import { expect, test } from '../support/fixtures'
import { shopperWithOrder } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { formReady, signIn } from '../support/sign-in'

// AC-1: at Pixel 7 (412 px) a signed-in shopper's account pages are no wider than the viewport. On Astro the account
// grid's one `1fr` column would take the sidebar's min-content width (its nav is a row of `nowrap` links) without
// `min-width: 0` on `.account-sidebar`, and the dashboard's Email card would take the width of an email that does not
// break. The shopper's email is long and has no break opportunity in its local part for that reason. Runs on both
// template projects. The viewport is set here, not by the `@visual`-only mobile projects. `defaultBrowserType` cannot
// be set per describe; the project's chromium is the same browser.
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7']

const PASSWORD = 'TestPassword123!'

test.describe('Account at Pixel 7', () => {
  test.use(pixel7)

  test('AC-1: signed in, /account, profile, addresses, orders and an order’s detail are each no wider than the viewport', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const shopper = await shopperWithOrder(request, PASSWORD)

    await signIn(page, shopper.email, PASSWORD)
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
      timeout: 15_000,
    })

    const pages: Array<{ path: string; ready: () => Promise<void> }> = [
      {
        path: '/account',
        ready: () => expect(page.getByTestId('account-dashboard')).toContainText(shopper.email),
      },
      {
        path: '/account/profile',
        ready: () => expect(page.getByTestId('profile-firstName')).toHaveValue(shopper.firstName),
      },
      {
        path: '/account/addresses',
        ready: () => expect(page.getByTestId('add-address-form')).toBeVisible(),
      },
      {
        path: '/account/orders',
        ready: () => expect(page.getByTestId('orders-list')).toContainText(shopper.orderNumber),
      },
      {
        path: `/account/orders/${encodeURIComponent(shopper.orderNumber)}`,
        ready: () => expect(page.getByTestId('order-detail')).toContainText(shopper.orderNumber),
      },
    ]

    const viewportWidth = pixel7.viewport.width
    for (const { path, ready } of pages) {
      await page.goto(path)
      await ready()
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      // Mobile Chrome zooms out to fit a page wider than its viewport, which raises innerWidth to the page's width, so
      // scrollWidth ≤ innerWidth alone would pass on the defect: both are held to the device's 412. CI's Chromium
      // rounds a sub-pixel layout up to 413 on a page that fits (the defect measured 468), so one pixel is allowed.
      const measured = `${path}: scrollWidth ${scrollWidth}, innerWidth ${innerWidth}, Pixel 7 ${viewportWidth}`
      expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewportWidth + 1)
      expect.soft(innerWidth, measured).toBe(viewportWidth)
    }
  })

  // Kills: a select's intrinsic width (its longest option) widening the add form's grid track past the phone's width.
  test('AC-10: signed in, /account/addresses with South Georgia & South Sandwich Islands chosen is no wider than the viewport, and the country select ends inside its form', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000)
    const email = `countrywidth${randomUUID().slice(0, 8)}@e2e.test`
    const reg = await request.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(request),
      data: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Countrywidth' },
    })
    expect(reg.ok(), `POST /api/auth/register: ${await reg.text()}`).toBe(true)
    await signIn(page, email, PASSWORD)
    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
      timeout: 15_000,
    })

    await page.goto('/account/addresses')
    await formReady(page, 'nymbal-address-book')
    const form = page.getByTestId('add-address-form')
    const country = form.getByLabel('Country', { exact: true })
    await country.selectOption(
      { label: 'South Georgia & South Sandwich Islands' },
      { timeout: 10_000 },
    )

    const viewportWidth = pixel7.viewport.width
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    const measured = `/account/addresses: scrollWidth ${scrollWidth}, innerWidth ${innerWidth}, Pixel 7 ${viewportWidth}`
    expect.soft(scrollWidth, measured).toBeLessThanOrEqual(viewportWidth + 1)
    expect.soft(innerWidth, measured).toBe(viewportWidth)
    const select = await country.boundingBox()
    const box = await form.boundingBox()
    expect(
      select!.x + select!.width - (box!.x + box!.width),
      'country select past its form',
    ).toBeLessThanOrEqual(0)
  })
})
