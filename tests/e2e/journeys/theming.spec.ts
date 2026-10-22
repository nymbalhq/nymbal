import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P2-06 AC-5 on every storefront target, and P2-18 AC-3 on the project-elements fixture (@override).
// - theming.override-wins (P2-18 AC-3, replacing P2-06 AC-4's client-only override, which the server render made
//   obsolete): the store's elements entry (tests/e2e/fixtures/override-elements, on the astro-override and
//   nextjs-override targets) overrides nymbal-mini-cart. With JS off the header's mini-carts hold the project's shadow
//   content, so the server rendered the project's class under the tag; with JS on they are the project's class, and the
//   store still works around it: adding to cart from a PDP lands the line in GET /api/cart. Kills: the server rendering
//   the package element under an overridden tag; registerComponents() redefining or throwing on a defined tag; one
//   override breaking the other elements.
// - theming.tokens-apply: the add-to-cart button, a part in the element's shadow root, is painted with
//   --nymbal-color-primary as the template's own tokens.css declares it and :root resolves it. Kills: tokens that do
//   not cross the shadow boundary, and a template still on the package's tokens rather than its own file.

const PDP = 'ceramic-mug'
/** What only the package's nymbal-mini-cart renders, in light DOM or shadow root. */
const PACKAGE_PARTS =
  '[data-testid="mini-cart"], [data-testid="mini-cart-badge"], [part~="button"], [part~="badge"], [part~="icon"]'
const REPO = new URL('../../../', import.meta.url)

interface ApiCart {
  data: { items: Array<{ variantId: string; productName: string; qty: number }> }
}

interface ApiProduct {
  data: { slug: string; name: string }
}

/** The template's own tokens file for a project (`astro`, `nextjs` and their `-custom` runs). */
function tokensFile(project: string): string {
  const path = project.startsWith('astro')
    ? 'templates/astro/src/styles/tokens.css'
    : 'templates/nextjs/app/tokens.css'
  return fileURLToPath(new URL(path, REPO))
}

/** The value a stylesheet declares for a custom property, as written. */
function declared(css: string, property: string): string | undefined {
  const match = new RegExp(`${property}\\s*:\\s*([^;]+);`).exec(css)
  return match?.[1]?.trim()
}

test.describe('Theming', () => {
  // P2-18 AC-3: the override lives in the project's elements entry (the fixture), which the server honours too.
  test('AC-3: theming.override-wins: with JS off, every header nymbal-mini-cart holds the project’s shadow content and none of the package’s parts @override', async ({
    browser,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL
    const off = await browser.newContext({
      javaScriptEnabled: false,
      ...(baseURL !== undefined && { baseURL }),
    })
    const page = await off.newPage()
    await page.goto('/')

    const miniCarts = page.locator('header nymbal-mini-cart')
    const count = await miniCarts.count()
    expect(count, 'header mini-carts').toBeGreaterThan(0)
    await expect(miniCarts.getByTestId('project-mini-cart-marker')).toHaveCount(count)
    await expect(miniCarts.locator(PACKAGE_PARTS)).toHaveCount(0)
    await off.close()
  })

  test('AC-3: theming.override-wins: with JS on, the header’s nymbal-mini-carts are the project’s class, carry its marker and no package part, and adding to cart from a PDP with the package’s nymbal-add-to-cart lands the line in GET /api/cart @override', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    const product = (await (
      await page.request.get(`${API_URL}/api/products/${PDP}`)
    ).json()) as ApiProduct
    await page.goto(`/product/${PDP}`)
    await expect(page.getByTestId('product-title')).toHaveText(product.data.name, {
      timeout: 15_000,
    })

    const miniCarts = page.locator('header nymbal-mini-cart')
    await expect(miniCarts.first()).toBeAttached({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                customElements.get('nymbal-mini-cart') as unknown as
                  | { projectOwned?: boolean }
                  | undefined
              )?.projectOwned === true,
          ),
        { timeout: 15_000, message: 'customElements holds the project’s nymbal-mini-cart' },
      )
      .toBe(true)
    const count = await miniCarts.count()
    await expect(miniCarts.getByTestId('project-mini-cart-marker')).toHaveCount(count)
    await expect(miniCarts.locator(PACKAGE_PARTS)).toHaveCount(0)

    // The package's other elements still work: the PDP's nymbal-add-to-cart puts the line in the cart.
    const before = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart
    const qtyOf = (cart: ApiCart): number =>
      cart.data.items
        .filter((item) => item.productName === product.data.name)
        .reduce((sum, item) => sum + item.qty, 0)
    await page.locator('nymbal-add-to-cart').getByTestId('add-to-cart').click()
    await expect
      .poll(
        async () =>
          qtyOf((await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(qtyOf(before))

    expect(errors, 'pageerror during the journey').toEqual([])
  })

  test('AC-5: theming.tokens-apply: the PDP add-to-cart part="button" is painted with --nymbal-color-primary as the template’s own tokens.css declares it and :root resolves it', async ({
    page,
  }, testInfo) => {
    const file = tokensFile(testInfo.project.name)
    expect(existsSync(file), `the template's own tokens file ${file}`).toBe(true)
    const primary = declared(readFileSync(file, 'utf8'), '--nymbal-color-primary')
    expect(primary, `${file} declares --nymbal-color-primary`).toBeDefined()

    const product = (await (
      await page.request.get(`${API_URL}/api/products/${PDP}`)
    ).json()) as ApiProduct
    expect(product.data.slug).toBe(PDP)
    await page.goto(`/product/${PDP}`)
    await expect(page.getByTestId('product-title')).toHaveText(product.data.name, {
      timeout: 15_000,
    })

    // :root resolves the token to the value the template's own file declares.
    const onRoot = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--nymbal-color-primary').trim(),
    )
    expect(onRoot).toBe(primary)

    // The part inside the shadow root is painted with that colour.
    const button = page.locator('nymbal-add-to-cart [part~="button"]')
    await expect(button).toHaveCount(1, { timeout: 15_000 })
    const [painted, expected] = await button.evaluate((el, value) => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = value ?? ''
      document.body.append(probe)
      const resolved = getComputedStyle(probe).backgroundColor
      probe.remove()
      return [getComputedStyle(el).backgroundColor, resolved]
    }, primary)
    expect(expected, 'the declared value is a colour').not.toBe('rgba(0, 0, 0, 0)')
    expect(painted).toBe(expected)
  })
})
