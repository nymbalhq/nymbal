import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// P2-06 AC-4 and AC-5 on every storefront target.
// - theming.override-wins: a tag the project defines before the page's scripts run (as its elements entry would) is
//   the one the page uses, and the store still works around it: adding to cart from a PDP lands the line in
//   GET /api/cart, and the mini-cart badge shows its quantity. Kills: registerComponents() redefining or throwing on a
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
  test('AC-4: theming.override-wins: a nymbal-toast the project defines first is the page’s, and adding to cart from a PDP still lands the line in GET /api/cart with the mini-cart badge at its quantity', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      class ProjectToast extends HTMLElement {
        static projectOwned = true

        connectedCallback(): void {
          if (this.querySelector('[data-testid="project-toast-marker"]') !== null) return
          const marker = document.createElement('span')
          marker.dataset['testid'] = 'project-toast-marker'
          marker.hidden = true
          this.append(marker)
        }

        show(message: string): void {
          const line = document.createElement('p')
          line.dataset['testid'] = 'project-toast-message'
          line.textContent = message
          this.append(line)
        }
      }
      customElements.define('nymbal-toast', ProjectToast)
    })

    const product = (await (
      await page.request.get(`${API_URL}/api/products/${PDP}`)
    ).json()) as ApiProduct
    await page.goto(`/product/${PDP}`)
    await expect(page.getByTestId('product-title')).toHaveText(product.data.name, {
      timeout: 15_000,
    })

    // The page's nymbal-toast is the project's class: every one on the page carries its marker.
    const toasts = page.locator('nymbal-toast')
    await expect(toasts.first()).toBeAttached({ timeout: 15_000 })
    await expect(page.locator('nymbal-toast [data-testid="project-toast-marker"]')).toHaveCount(
      await toasts.count(),
    )
    const owner = await page.evaluate(
      () =>
        (customElements.get('nymbal-toast') as unknown as { projectOwned?: boolean } | undefined)
          ?.projectOwned === true,
    )
    expect(owner, 'customElements holds the project’s nymbal-toast').toBe(true)

    // The other elements still work: the add lands in the cart, and the badge shows the cart's quantity.
    await page.getByTestId('add-to-cart').click()
    await expect(
      page.getByTestId('cart-drawer').locator('[data-testid^="cart-item-"]').first(),
    ).toBeVisible({ timeout: 10_000 })
    const cart = (await (await page.request.get(`${API_URL}/api/cart`)).json()) as ApiCart
    expect(cart.data.items.map((item) => item.productName)).toContain(product.data.name)
    const quantity = cart.data.items.reduce((sum, item) => sum + item.qty, 0)
    expect(quantity).toBeGreaterThan(0)
    await expect(page.getByTestId('mini-cart-badge')).toHaveText(String(quantity))
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
