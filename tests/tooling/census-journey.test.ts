// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupScratch, gateCli, git, scratchRepo, write } from './scratch-gate'

// AC-12: the census trend's journey rule. On a touched tests/e2e/journeys/** file, every test() needs an assertion
// outside C1, and the file needs an API read (the `request` fixture, `page.request` or `fetch`, to /api/) whose value
// reaches an expect(). Violations print as rule 2's do, with the text `journey rule`. Each bad shape below also holds
// a C3 assertion, so rule 2 alone passes it and only the journey rule can name it. The step is the real
// `gate.ts census-trend <base>` on a scratch repo.

afterEach(cleanupScratch)

const J = 'tests/e2e/journeys'

/** A test that passes the journey rule: an API read whose body is the expected value of a C3 assertion. */
const GOOD_TEST = `test('AC-1: the grid shows the products in the order the API returns', async ({ page, request }) => {
  const response = await request.get('/api/products?sort=price')
  const body = await response.json()
  await page.goto('/products?sort=price')
  const names = await page.getByTestId('product-title').allTextContents()
  expect(names.length).toBeGreaterThan(0)
  expect(names).toEqual(body.items.map((p: { name: string }) => p.name))
})
`

const journey = (...tests: string[]): string =>
  [`import { expect, test } from '@playwright/test'`, '', ...tests].join('\n')

const FILES = {
  good: `${J}/sort-order.spec.ts`,
  goodPageRequest: `${J}/cart-badge.spec.ts`,
  presence: `${J}/browse-presence.spec.ts`,
  noApiRead: `${J}/guest-checkout-no-api.spec.ts`,
  decorative: `${J}/guest-checkout-decorative.spec.ts`,
  untouched: `${J}/browse-untouched.spec.ts`,
}

const PRESENCE_TEST = `test('the sort control is there', async ({ page }) => {
  await page.goto('/products')
  await expect(page.getByTestId('sort-dropdown')).toBeVisible()
})
`

const CHECKOUT_UI_ONLY = `test('places an order', async ({ page }) => {
  await page.goto('/checkout')
  await page.getByTestId('place-order').click()
  const number = (await page.getByTestId('order-number').textContent()) ?? ''
  expect(number.length).toBeGreaterThan(4)
  await expect(page.getByTestId('order-number')).toHaveText(/^(NYM|INT)-/)
})
`

const CHECKOUT_DECORATIVE = `test('places an order', async ({ page, request }) => {
  await request.get('/api/health')
  await page.goto('/checkout')
  await page.getByTestId('place-order').click()
  const number = (await page.getByTestId('order-number').textContent()) ?? ''
  expect(number.length).toBeGreaterThan(4)
})
`

const PAGE_REQUEST_TEST = `test('the badge counts the lines the API holds', async ({ page }) => {
  await page.goto('/cart')
  const response = await page.request.get('/api/cart')
  const cart = await response.json()
  const badge = Number(await page.getByTestId('mini-cart-badge').textContent())
  expect(badge).toBe(cart.items.reduce((n: number, line: { quantity: number }) => n + line.quantity, 0))
})
`

/** The paths named on violation lines that carry `journey rule`, and those on the other violation lines. */
function violations(out: string): { journey: string[]; other: string[] } {
  const lines = out.split('\n').filter((l) => l.startsWith('violation:'))
  const path = (l: string): string => /(tests\/e2e\/journeys\/[\w./-]+\.spec\.ts)/.exec(l)?.[1] ?? l
  return {
    journey: [...new Set(lines.filter((l) => l.includes('journey rule')).map(path))].sort(),
    other: lines.filter((l) => !l.includes('journey rule')).map(path),
  }
}

describe('AC-12: the journey rule judges touched journeys', () => {
  it('AC-12: presence-only, no API read and a decorative read are violations; good journeys and untouched ones are not', async () => {
    const repo = scratchRepo({
      'package.json': JSON.stringify({ name: 'census-scratch', private: true }),
      // Old debt in the browse.spec.ts:33-37 shape, never touched by the change.
      [FILES.untouched]: journey(GOOD_TEST, PRESENCE_TEST),
    })
    const base = git(repo.root, 'rev-parse', 'HEAD')
    write(repo.root, FILES.good, journey(GOOD_TEST))
    write(repo.root, FILES.goodPageRequest, journey(PAGE_REQUEST_TEST))
    write(repo.root, FILES.presence, journey(GOOD_TEST, PRESENCE_TEST))
    write(repo.root, FILES.noApiRead, journey(CHECKOUT_UI_ONLY))
    write(repo.root, FILES.decorative, journey(CHECKOUT_DECORATIVE))
    git(repo.root, 'add', '-A')
    git(repo.root, 'commit', '-q', '-m', 'journeys')

    const run = await gateCli(repo, ['census-trend', base], {}, false)
    const found = violations(run.output)

    expect(run.output).toMatch(/^census trend against /m)
    // Rule 2 passes every file: each holds a C3 assertion.
    expect(found.other, run.output).toEqual([])
    expect(found.journey, run.output).toEqual(
      [FILES.presence, FILES.noApiRead, FILES.decorative].sort(),
    )
    expect(found.journey.length).toBeLessThan(Object.keys(FILES).length)
    expect(run.code, run.output).toBe(1)
  })
})
