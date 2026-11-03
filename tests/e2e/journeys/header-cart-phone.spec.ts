import { request as playwrightRequest, type Locator } from '@playwright/test'
import { adminToken, ownProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { cartLines } from '../support/variants'

// The header's cart is one tap away at a phone's width: the mini-cart shows in the header with the menu closed, not
// inside the collapsible menu, and a tap on it opens the cart drawer. The menu toggle still shows the nav links. From
// 769 px the mini-cart stays in the header's actions row.

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function boxOf(locator: Locator, name: string): Promise<Box> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error(`${name} has no box`)
  return box
}

/** Whether `inner` lies within `outer`, allowing Chromium's one pixel of sub-pixel rounding. */
function within(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  )
}

test.describe('The header’s cart at a phone’s width @phone-width', () => {
  test('AC-3: cart.header-cart-phone: at 412 px with the menu closed the mini-cart is visible inside the viewport and the header, one tap on it puts the cart drawer in the viewport, and the menu toggle still shows the nav links', async ({
    page,
  }) => {
    expect(page.viewportSize()?.width, 'a phone-width project').toBe(412)
    // The admin signs in on a context of its own, so the page stays a guest's; the line goes into the page's cart.
    const admin = await playwrightRequest.newContext()
    let variantId: string
    try {
      variantId = (await ownProduct(admin, await adminToken(admin), 5)).variantId
    } finally {
      await admin.dispose()
    }
    const added = await page.request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(page.request),
      data: { variantId, qty: 1 },
    })
    expect(added.ok(), `POST /api/cart/items: ${await added.text()}`).toBe(true)

    await page.goto('/')
    const header = page.locator('nymbal-site-header')
    const bar = header.getByTestId('site-header')
    const miniCart = header.getByTestId('mini-cart')
    const links = header.locator('[part~="link"]')
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await expect(links.first(), 'the menu starts closed').toBeHidden()

    await expect(miniCart, 'the mini-cart shows with the menu closed').toBeVisible({
      timeout: 5_000,
    })
    await expect(miniCart).toBeInViewport({ ratio: 1 })
    const cartBox = await boxOf(miniCart, 'the mini-cart')
    const barBox = await boxOf(bar, 'the header')
    expect(
      within(cartBox, barBox),
      `mini-cart ${JSON.stringify(cartBox)} in header ${JSON.stringify(barBox)}`,
    ).toBe(true)

    const drawer = page.getByTestId('cart-drawer')
    await expect(drawer).not.toBeInViewport()
    await miniCart.tap()
    await expect(drawer, 'one tap opens the cart drawer').toBeInViewport({ timeout: 10_000 })
    const lines = await cartLines(page)
    expect(
      lines.map((l) => l.variantId),
      'GET /api/cart holds the line added',
    ).toEqual([variantId])
    await expect(
      drawer.locator('[data-testid^="cart-item-"]'),
      'the drawer holds the lines GET /api/cart holds',
    ).toHaveCount(lines.length)
    expect(
      await drawer
        .locator('[data-testid^="cart-item-"]')
        .evaluateAll((items) => items.map((n) => n.getAttribute('data-testid'))),
    ).toEqual(lines.map((l) => `cart-item-${l.variantId}`))
    await page.getByTestId('cart-drawer-close').tap()
    await expect(drawer).not.toBeInViewport({ timeout: 5_000 })

    await expect(links.first()).toBeHidden()
    await header.locator('[part~="toggle"]').tap()
    await expect(links.first(), 'the toggle opens the menu').toBeInViewport({ timeout: 5_000 })
  })
})

test('AC-3: from 769 px the mini-cart sits in the header’s actions row, right of where the actions start', async ({
  page,
}) => {
  expect(page.viewportSize()?.width ?? 0, 'a desktop project').toBeGreaterThanOrEqual(769)
  await page.goto('/')
  const header = page.locator('nymbal-site-header')
  const miniCart = header.getByTestId('mini-cart')
  const actions = header.locator('[part~="actions"]')
  await expect(miniCart).toBeVisible({ timeout: 15_000 })

  const cartBox = await boxOf(miniCart, 'the mini-cart')
  const actionsBox = await boxOf(actions, 'the actions')
  const middle = cartBox.y + cartBox.height / 2
  expect(middle, 'the mini-cart’s middle is within the actions row').toBeGreaterThanOrEqual(
    actionsBox.y - 1,
  )
  expect(middle).toBeLessThanOrEqual(actionsBox.y + actionsBox.height + 1)
  expect(cartBox.x).toBeGreaterThanOrEqual(actionsBox.x - 1)
})
