import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL } from '../support/csrf'
import { expect, test } from '../support/fixtures'

// What a shopper's miss leaves in the merchant's report: opening the search page counts one, typing into a search bar
// counts none, on both templates.

interface Report {
  window: { timezone: string }
  zeroResultSearches: { items: Array<{ term: string; searches: number }> }
}

async function reportFor(
  request: APIRequestContext,
  token: string,
  query: string,
): Promise<Report> {
  const res = await request.get(`${API_URL}/api/admin/reports${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET /api/admin/reports${query}: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: Report }).data
}

function storeDayOf(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** Today's zero-result searches, as the report reads them for the current store day. */
async function todaysSearches(request: APIRequestContext, token: string) {
  const { window } = await reportFor(request, token, '')
  const day = storeDayOf(window.timezone)
  return (await reportFor(request, token, `?from=${day}&to=${day}`)).zeroResultSearches.items
}

const searchesOf = async (request: APIRequestContext, token: string, term: string) =>
  (await todaysSearches(request, token)).find((item) => item.term === term)?.searches ?? 0

const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`

async function typeInto(page: Page, input: ReturnType<Page['locator']>, text: string): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/products/search') &&
      response.url().includes(`q=${encodeURIComponent(text)}`),
  )
  await input.pressSequentially(text, { delay: 50 })
  await answered
}

test.describe('Zero-result search capture', () => {
  test('AC-30: opening /search?q=<miss> shows the empty state and adds exactly one to the term in the report; typing fragments into the header search bar, and into Astro’s page input, adds none', async ({
    page,
    request,
  }, testInfo) => {
    const token = await adminToken(request)
    const miss = unique('zqmiss')
    const before = await searchesOf(request, token, miss)
    expect(before).toBe(0)

    await page.goto(`/search?q=${miss}`)
    await expect(page.getByRole('heading', { name: 'No results found' })).toBeVisible({
      timeout: 15_000,
    })
    await expect.poll(() => searchesOf(request, token, miss), { timeout: 15_000 }).toBe(1)

    const fragment = unique('zqfrag')
    await typeInto(page, page.locator('nymbal-site-header nymbal-search-bar input'), fragment)
    if (testInfo.project.name === 'astro') {
      await page.goto('/search')
      await typeInto(page, page.locator('#search-input'), fragment)
    }

    const marker = unique('zqmark')
    await page.goto(`/search?q=${marker}`)
    await expect.poll(() => searchesOf(request, token, marker), { timeout: 15_000 }).toBe(1)

    const items = await todaysSearches(request, token)
    expect(items.filter((item) => item.term.startsWith(fragment.slice(0, 6)))).toEqual([])
    expect(items.find((item) => item.term === miss)?.searches).toBe(before + 1)
  })
})
