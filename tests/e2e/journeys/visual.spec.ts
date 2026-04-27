import { test, expect } from '../support/fixtures'

const PAGES = [
  { name: 'homepage', path: '/' },
  { name: 'products', path: '/products' },
  { name: 'cart-empty', path: '/cart' },
  { name: 'search', path: '/search' },
  { name: 'account-login', path: '/account/login' },
  { name: 'account-register', path: '/account/register' },
  { name: 'not-found', path: '/this-page-does-not-exist' },
]

test.beforeEach(async ({ page }) => {
  // Disable CSS animations for stable screenshots
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
      animation-duration: 0s !important;
    }`,
  })
})

for (const { name, path } of PAGES) {
  test(`${name} @visual`, async ({ page }) => {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    // Wait for fonts
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot(`${name}.png`, {
      fullPage: false,
      maxDiffPixelRatio: 0.01,
    })
  })
}
