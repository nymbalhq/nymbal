import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P2-06 AC-4 and AC-5 on every storefront target.
// - theming.override-wins: a nymbal-mini-cart the project defines before the page's scripts run (as its elements entry would) is
//   the one the page uses, and the store still works around it: adding to cart from a PDP lands the line in
//   GET /api/cart. Kills: registerComponents() redefining or throwing on a
//   defined tag, or one override breaking the other elements.
// - theming.tokens-apply: the add-to-cart button, a part in the element's shadow root, is painted with
//   --nymbal-color-primary as the template's own tokens.css declares it and :root resolves it. Kills: tokens that do
//   not cross the shadow boundary, and a template still on the package's tokens rather than its own file.

const PDP = 'ceramic-mug'
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
  test('AC-4: theming.override-wins: a nymbal-mini-cart the project defines first is the header’s, and adding to cart from a PDP with the package’s nymbal-add-to-cart lands the line in GET /api/cart', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      class ProjectMiniCart extends HTMLElement {
        static projectOwned = true

        // The marker lives in the project's own shadow root: React hydrates the header's light DOM on nextjs, and a
        // light-DOM child it did not render is a hydration error, not the defect this test is for.
        connectedCallback(): void {
          if (this.shadowRoot !== null) return
          const marker = document.createElement('span')
          marker.dataset['testid'] = 'project-mini-cart-marker'
          marker.textContent = 'cart'
          this.attachShadow({ mode: 'open' }).append(marker)
        }
      }
      customElements.define('nymbal-mini-cart', ProjectMiniCart)
    })

    const product = (await (
      await page.request.get(`${API_URL}/api/products/${PDP}`)
    ).json()) as ApiProduct
    await page.goto(`/product/${PDP}`)
    await expect(page.getByTestId('product-title')).toHaveText(product.data.name, {
      timeout: 15_000,
    })

    // The header's nymbal-mini-cart is the project's class: each one carries the project's marker (in its shadow root),
    // and none holds a part the package renders, in light DOM or shadow root.
    const miniCarts = page.locator('header nymbal-mini-cart')
    await expect(miniCarts.first()).toBeAttached({ timeout: 15_000 })
    const count = await miniCarts.count()
    await expect(miniCarts.getByTestId('project-mini-cart-marker')).toHaveCount(count)
    const packageParts = await miniCarts.evaluateAll(
      (elements) =>
        elements.filter(
          (el) =>
            el.querySelector(
              '[data-testid="mini-cart"], [data-testid="mini-cart-badge"], [part]',
            ) !== null ||
            (el.shadowRoot?.querySelector(
              '[part], [data-testid]:not([data-testid="project-mini-cart-marker"])',
            ) ?? null) !== null,
        ).length,
    )
    expect(packageParts, 'header mini-carts holding a package part').toBe(0)
    const owner = await page.evaluate(
      () =>
        (
          customElements.get('nymbal-mini-cart') as unknown as
            | { projectOwned?: boolean }
            | undefined
        )?.projectOwned === true,
    )
    expect(owner, 'customElements holds the project’s nymbal-mini-cart').toBe(true)

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
