import { expect, test } from '../support/fixtures'
import AxeBuilder from '@axe-core/playwright'

const pages = [
  { name: 'homepage', path: '/' },
  { name: 'products', path: '/products' },
  { name: 'search', path: '/search' },
  { name: 'cart', path: '/cart' },
  { name: 'login', path: '/account/login' },
  { name: 'register', path: '/account/register' },
]

for (const { name, path } of pages) {
  test(`${name} has no axe accessibility violations @a11y`, async ({ page }) => {
    await page.goto(path)
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .disableRules(['color-contrast']) // Shadow DOM causes false positives for color-contrast
      .analyze()

    expect(results.violations).toEqual([])
  })
}
