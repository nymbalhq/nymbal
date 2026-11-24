import { adminToken, ownProduct } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { cartQty } from '../support/variants'

// On both templates an add the store refuses (a cart line already holds the 99 it may) says why under the button,
// does not open the cart drawer as if it had worked, and leaves the cart as it was.

const LINE_MAX = 99
const LIMIT_SENTENCE = 'You can have at most 99 of this item in your cart.'

test.describe('A refused add to cart', () => {
  test('AC-3: with 99 of a variant in the cart, Add to Cart on its product page shows the limit sentence, the cart drawer stays closed, and the badge and GET /api/cart still read 99', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const product = await ownProduct(request, await adminToken(request), LINE_MAX + 21)

    // The browser context's own cart, through the API, so the page's cookie names the cart that holds the 99.
    const held = await page.request.post(`${API_URL}/api/cart/items`, {
      headers: await csrf(page.request),
      data: { variantId: product.variantId, qty: LINE_MAX },
    })
    expect(held.status(), `POST /api/cart/items: ${await held.text()}`).toBe(200)

    await page.goto(`/product/${product.slug}`)
    await page.waitForLoadState('networkidle')
    const before = await cartQty(page, product.variantId)
    expect(before, 'GET /api/cart before the add').toBe(LINE_MAX)
    const badge = page.getByTestId('mini-cart-badge')
    await expect(badge, 'the badge before the add').toHaveText(String(before), {
      timeout: 15_000,
    })

    const main = page.locator('main')
    const answered = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/cart/items' && res.request().method() === 'POST',
    )
    await main.getByTestId('add-to-cart').click()
    const refusal = await answered
    expect(refusal.status(), 'the API refuses the 100th unit').toBeGreaterThanOrEqual(400)

    await expect.soft(main.getByTestId('add-to-cart-error')).toHaveText(LIMIT_SENTENCE)
    await expect.soft(page.locator('nymbal-cart-drawer')).not.toHaveAttribute('open', '')
    await expect(page.getByTestId('cart-drawer')).not.toBeInViewport()
    expect(await cartQty(page, product.variantId), 'GET /api/cart after the refused add').toBe(
      before,
    )
    await expect(badge, 'the badge after the refused add').toHaveText(String(before))
  })
})
