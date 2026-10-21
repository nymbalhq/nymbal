import { adminToken, ownProduct } from '../support/checkout'
import { expect, test } from '../support/fixtures'
import {
  cartLines,
  cartQty,
  formatPrice,
  optionProduct,
  specStockLevel,
  type OptionCombination,
  type ServedVariant,
} from '../support/variants'

// P2-12 on both templates: the shopper picks a quantity and a variant on the product page and gets exactly that in
// the cart, and the cart page's steppers change the line in the API.
//
// AC-2 (`cart.quantity`): the PDP's quantity selector sets what add-to-cart adds, stepped or typed (a typed fraction
// shows and adds its whole part); /cart's selector on the line moves the API quantity up and down, cannot go below 1,
// and the line's remove button empties it. Kills: a decorative stepper (Astro's PDP adds 1 whatever it shows), a PDP
// without one (Next), a selector that shows one quantity and emits another, a PDP that adds the quantity from before
// the click committed the typing, and a cart page whose steppers or remove button differ between the templates
// (Astro's hand-rolled buttons, which remove at 1; Next's untested remove).
//
// AC-3 (`browse.variant-shape`): a product of two options of two values each, one combination at stock 0 and one at
// stock 2. Both PDPs render exactly the options the API serves; selecting each combination shows its price, a
// `stock-badge` whose `data-level` is the spec's stock level and add-to-cart for its id, disabled exactly at stock 0;
// adding puts that id in the API cart; the quantity resets to 1 on every change. The server render (no script) shows
// variants[0]. Kills: templates that render different options, or a selection the price, badge or add-to-cart does not
// follow.

/** variants[0], what the server renders, is the stock-2 one, so its level is neither in nor out. */
const COMBINATIONS: OptionCombination[] = [
  {
    options: [
      { name: 'Colour', value: 'Red' },
      { name: 'Size', value: 'S' },
    ],
    priceMinor: 1500,
    stock: 2,
  },
  {
    options: [
      { name: 'Colour', value: 'Red' },
      { name: 'Size', value: 'M' },
    ],
    priceMinor: 2600,
    stock: 0,
  },
  {
    options: [
      { name: 'Colour', value: 'Blue' },
      { name: 'Size', value: 'S' },
    ],
    priceMinor: 3700,
    stock: 7,
  },
  {
    options: [
      { name: 'Colour', value: 'Blue' },
      { name: 'Size', value: 'M' },
    ],
    priceMinor: 4800,
    stock: 12,
  },
]

test.describe('P2-12: PDP quantity and variants', () => {
  test('AC-2: the PDP adds the quantity its selector shows (3 by steps, then a typed 5.7 shown and added as 5 on an immediate click), the badge reads it, /cart steps the API line up one and back, stops at 1, and cart-remove empties it', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const product = await ownProduct(request, await adminToken(request), 20)
    await page.goto(`/product/${product.slug}`)
    await page.waitForLoadState('networkidle')
    const pdp = page.locator('main')

    const input = pdp.getByTestId('qty-input')
    await expect(input, 'the PDP’s quantity selector').toHaveValue('1', { timeout: 15_000 })
    const increments = 2
    for (let i = 1; i <= increments; i++) {
      await pdp.getByTestId('qty-increment').click()
      await expect(input).toHaveValue(String(1 + i))
    }
    const stepped = Number(await input.inputValue())
    expect(stepped).toBe(1 + increments)

    await pdp.getByTestId('add-to-cart').click()
    await expect
      .poll(() => cartQty(page, product.variantId), { timeout: 10_000 })
      .toBe(stepped)
    await page.getByTestId('cart-drawer-close').click()
    await expect(page.getByTestId('cart-drawer')).not.toBeInViewport()

    // A typed fraction, then Add at once: the press itself commits the typing (blur, then change), and there is no
    // delay between mousedown and mouseup for an update to land in. The selector shows the whole part, and that is
    // what add-to-cart adds.
    await input.fill('5.7')
    await pdp.getByTestId('add-to-cart').click()
    await expect(input, 'a typed fraction shows as its whole part').toHaveValue('5')
    const typed = Number(await input.inputValue())
    await expect
      .poll(() => cartQty(page, product.variantId), { timeout: 10_000 })
      .toBe(stepped + typed)
    const shown = stepped + typed

    const lines = await cartLines(page)
    expect(lines.map((l) => [l.variantId, l.qty])).toEqual([[product.variantId, shown]])
    await expect(page.getByTestId('mini-cart-badge')).toHaveText(
      String(lines.reduce((sum, l) => sum + l.qty, 0)),
    )

    await page.goto('/cart')
    const line = page.locator('main').getByTestId(`cart-item-${product.variantId}`)
    const lineInput = line.getByTestId('qty-input')
    await expect(lineInput, 'the cart line’s quantity selector').toHaveValue(String(shown), {
      timeout: 15_000,
    })

    // One step up and one down, each answered by the API before the next.
    await line.getByTestId('qty-increment').click()
    await expect.poll(() => cartQty(page, product.variantId)).toBe(shown + 1)
    await expect(lineInput).toHaveValue(String(shown + 1))
    await line.getByTestId('qty-decrement').click()
    await expect.poll(() => cartQty(page, product.variantId)).toBe(shown)
    await expect(lineInput).toHaveValue(String(shown))

    // Down to 1, where the decrement is disabled and the line is still in the cart.
    for (let qty = shown - 1; qty >= 1; qty--) {
      await line.getByTestId('qty-decrement').click()
      await expect.poll(() => cartQty(page, product.variantId)).toBe(qty)
      await expect(lineInput).toHaveValue(String(qty))
    }
    await expect(line.getByTestId('qty-decrement')).toBeDisabled()
    expect(await cartQty(page, product.variantId)).toBe(1)

    await page.locator('main').getByTestId(`cart-remove-${product.variantId}`).click()
    await expect
      .poll(async () => (await cartLines(page)).map((l) => l.variantId))
      .not.toContain(product.variantId)
    await expect(line).toHaveCount(0)
  })

  test('AC-3: a 2×2 option product renders the API’s options, and each selected combination shows its price, stock level and add-to-cart (disabled at stock 0), adds its own id, and resets the quantity to 1', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const product = await optionProduct(request, await adminToken(request), COMBINATIONS)
    const first = product.variants[0]!

    // The server render, no script: variants[0] under the same rule.
    const baseURL = testInfo.project.use.baseURL
    const noScript = await browser.newContext({
      javaScriptEnabled: false,
      ...(baseURL !== undefined && { baseURL }),
    })
    const served = await noScript.newPage()
    await served.goto(`/product/${product.slug}`)
    await expect(served.locator('main').getByTestId('product-price')).toHaveText(
      formatPrice(first.priceMinor, product.currency),
    )
    await expect(served.locator('main').getByTestId('stock-badge')).toHaveAttribute(
      'data-level',
      specStockLevel(first.stock),
    )
    await noScript.close()

    await page.goto(`/product/${product.slug}`)
    await page.waitForLoadState('networkidle')
    const pdp = page.locator('main')

    // The options the PDP renders are the API's, one per distinct name and value.
    const apiOptions = [
      ...new Set(
        product.variants.flatMap((v) => v.options.map((o) => `variant-option-${o.name}-${o.value}`)),
      ),
    ].sort()
    const rendered = pdp.locator('[data-testid^="variant-option-"]')
    await expect(rendered).toHaveCount(apiOptions.length, { timeout: 15_000 })
    expect(
      (await rendered.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).sort(),
    ).toEqual(apiOptions)

    const input = pdp.getByTestId('qty-input')
    const addToCart = pdp.getByTestId('add-to-cart')
    // Every combination, each one a change from the one before (variants[0] is selected first, so it comes last).
    for (const variant of [...product.variants.slice(1), first]) {
      await expect(input).toHaveValue('1', { timeout: 10_000 })
      await pdp.getByTestId('qty-increment').click()
      await expect(input).toHaveValue('2')

      for (const o of variant.options) {
        await pdp.getByTestId(`variant-option-${o.name}-${o.value}`).click()
      }
      for (const o of variant.options) {
        await expect(pdp.getByTestId(`variant-option-${o.name}-${o.value}`)).toHaveAttribute(
          'aria-pressed',
          'true',
        )
      }

      await expect(pdp.getByTestId('product-price')).toHaveText(
        formatPrice(variant.priceMinor, product.currency),
      )
      await expect(pdp.getByTestId('stock-badge')).toHaveAttribute(
        'data-level',
        specStockLevel(variant.stock),
      )
      await expect(pdp.locator('nymbal-add-to-cart')).toHaveAttribute('variant-id', variant.id)
      await expect.poll(() => addToCart.isDisabled()).toBe(variant.stock <= 0)
      await expect(input, 'the quantity resets to 1 on a variant change').toHaveValue('1')

      if (variant.stock > 0) {
        const qty = Number(await input.inputValue())
        await addToCart.click()
        await expect.poll(() => cartQty(page, variant.id), { timeout: 10_000 }).toBe(qty)
        await page.getByTestId('cart-drawer-close').click()
        await expect(page.getByTestId('cart-drawer')).not.toBeInViewport()
      }
    }

    // A quantity changed on a variant does not outlive it: away and back, add-to-cart adds what the stepper shows.
    const [away, back] = product.variants.filter((v) => v.stock > 0 && v.id !== first.id)
    const select = async (variant: ServedVariant) => {
      for (const o of variant.options) {
        await pdp.getByTestId(`variant-option-${o.name}-${o.value}`).click()
      }
      await expect(pdp.locator('nymbal-add-to-cart')).toHaveAttribute('variant-id', variant.id)
    }
    await select(back!)
    await expect(input).toHaveValue('1')
    await pdp.getByTestId('qty-increment').click()
    await pdp.getByTestId('qty-increment').click()
    await expect(input).toHaveValue('3')
    await select(away!)
    await select(back!)
    const before = await cartQty(page, back!.id)
    const shownOnReturn = Number(await input.inputValue())
    await addToCart.click()
    await expect
      .poll(async () => (await cartQty(page, back!.id)) - before, { timeout: 10_000 })
      .toBe(shownOnReturn)
    await page.getByTestId('cart-drawer-close').click()
    await expect(page.getByTestId('cart-drawer')).not.toBeInViewport()

    // The cart holds exactly the in-stock combinations, by the ids the API serves for them.
    expect((await cartLines(page)).map((l) => l.variantId).sort()).toEqual(
      product.variants.filter((v) => v.stock > 0).map((v) => v.id).sort(),
    )
  })
})
