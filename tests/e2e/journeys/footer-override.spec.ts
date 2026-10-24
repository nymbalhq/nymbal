import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// AC-4, the override clause, on the `astro-override` and `nextjs-override` targets: the project's elements entry
// (tests/e2e/fixtures/override-elements) overrides `nymbal-site-footer` as it overrides `nymbal-mini-cart`. With JS
// off the page's footer holds the project's marker part and none of the package footer's, so the server rendered the
// project's class under the tag; with JS on the tag is the project's class and still shows the marker and no package
// part, and the package's other chrome still renders the store's data around it (the category nav's cards are
// `GET /api/categories`').

/** What only the package's nymbal-site-footer renders. */
const PACKAGE_PARTS =
  '[data-testid="site-footer"], [part~="footer"], [part~="column"], [part~="heading"], [part~="link"], [part~="legal"]'

test.describe('AC-4: a project overrides nymbal-site-footer by tag', () => {
  test('AC-4: theming.chrome-is-elements: with JS off, nymbal-site-footer holds the project’s marker and none of the package’s parts @override', async ({
    browser,
  }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL
    const off = await browser.newContext({
      javaScriptEnabled: false,
      ...(baseURL !== undefined && { baseURL }),
    })
    try {
      const page = await off.newPage()
      await page.goto('/')
      const footer = page.locator('nymbal-site-footer')
      await expect(footer).toHaveCount(1)
      expect(await footer.getByTestId('project-site-footer-marker').count()).toBe(
        await footer.count(),
      )
      await expect(footer.locator(PACKAGE_PARTS)).toHaveCount(0)
    } finally {
      await off.close()
    }
  })

  test('AC-4: theming.chrome-is-elements: with JS on, nymbal-site-footer is the project’s class with its marker and no package part @override', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'load' })
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                customElements.get('nymbal-site-footer') as unknown as
                  | { projectOwned?: boolean }
                  | undefined
              )?.projectOwned === true,
          ),
        { timeout: 15_000, message: 'customElements holds the project’s nymbal-site-footer' },
      )
      .toBe(true)
    const footer = page.locator('nymbal-site-footer')
    await expect(footer).toHaveCount(1)
    await expect(footer.getByTestId('project-site-footer-marker')).toHaveCount(1)
    await expect(footer.locator(PACKAGE_PARTS)).toHaveCount(0)

    const res = await page.request.get(`${API_URL}/api/categories`)
    expect(res.status()).toBe(200)
    const categories = ((await res.json()) as { data: Array<{ slug: string }> }).data
    const cards = page.locator('nymbal-category-nav [part~="card"]')
    await expect
      .poll(() => cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))))
      .toEqual(categories.map((c) => `category-${c.slug}`))
  })
})
