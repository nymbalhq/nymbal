import { adminToken, ownProduct } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// The open cart drawer's overlay covers the page. Escape closes it, so the shopper's next click reaches the page: a
// second Add to Cart, with nothing clicked between, adds a second unit.

interface ApiCart {
  data: { items: Array<{ variantId: string; qty: number }> }
}

test('AC-2: cart.drawer-escape: Escape takes the open cart drawer out of the viewport, and the next Add to Cart click adds to GET /api/cart: the variant at quantity 2 and the mini-cart badge at the quantity sum', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  // A product of this test's own, so no other journey moves its stock or its line.
  const product = await ownProduct(request, await adminToken(request), 5)
  await page.goto(`/product/${product.slug}`)
  const add = page.getByTestId('add-to-cart')
  const drawer = page.getByTestId('cart-drawer')
  const line = drawer.getByTestId(`cart-item-${product.variantId}`)

  await add.click()
  await expect(drawer).toBeInViewport({ timeout: 10_000 })
  await expect(line).toContainText('Qty: 1', { timeout: 10_000 })

  await page.keyboard.press('Escape')
  await expect(drawer, 'Escape closes the drawer').not.toBeInViewport({ timeout: 5_000 })

  await add.click({ timeout: 5_000 })
  await expect(line).toContainText('Qty: 2', { timeout: 10_000 })

  const cart = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart
  const held = cart.data.items.find((i) => i.variantId === product.variantId)
  expect(held?.qty, 'the second click added a unit').toBe(2)
  const sum = cart.data.items.reduce((total, i) => total + i.qty, 0)
  await expect(page.getByTestId('mini-cart-badge')).toHaveText(String(sum))
})
