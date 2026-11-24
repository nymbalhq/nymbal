import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// On both templates every link the site footer renders opens a page of the store: it answers 200 and is not the
// store's not-found page. The links are read from the rendered footer, not from the template's configuration.

/** Both templates' not-found pages carry this heading (Astro's 404.astro, Next's NotFoundView). */
const NOT_FOUND_HEADING = /page not found/i

test.describe('Site footer links', () => {
  test('AC-4: every link in the site footer opens a page that answers 200 and is not the not-found page', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.goto('/')
    const links = page.locator('nymbal-site-footer [part~="link"]')
    await expect(links.first(), 'the footer renders its links').toBeAttached({ timeout: 15_000 })
    const hrefs = [
      ...new Set(
        await links.evaluateAll((els) =>
          els.map((el) => new URL((el as HTMLAnchorElement).href, location.href).pathname),
        ),
      ),
    ]

    const opened: Array<{ href: string; status: number | null; notFound: boolean }> = []
    for (const href of hrefs) {
      const response = await page.goto(href)
      const notFound = await page
        .getByRole('heading', { level: 1, name: NOT_FOUND_HEADING })
        .isVisible()
      opened.push({ href, status: response?.status() ?? null, notFound })
    }

    expect(opened, 'each footer link: its status and whether it is the not-found page').toEqual(
      hrefs.map((href) => ({ href, status: 200, notFound: false })),
    )

    // A category link names a category the store has, not a page that renders for any slug.
    const res = await page.request.get(`${API_URL}/api/categories`)
    expect(res.status(), 'GET /api/categories').toBe(200)
    const slugs = new Set(
      ((await res.json()) as { data: Array<{ slug: string }> }).data.map((c) => c.slug),
    )
    const categoryLinks = hrefs.filter((href) => href.startsWith('/category/'))
    expect(
      categoryLinks.filter((href) => !slugs.has(href.slice('/category/'.length))),
      'footer category links naming no category of GET /api/categories',
    ).toEqual([])
  })
})
