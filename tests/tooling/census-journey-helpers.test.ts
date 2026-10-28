// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts, tests/e2e/support/**
// Reads: tests/e2e/journeys/**
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupScratch, gateCli, git, REPO, scratchRepo, write } from './scratch-gate'

// AC-12: the journey rule sees through helpers. When a test body calls a function imported from tests/e2e/support/**,
// that function's body counts as part of the test (its API reads and its matchers), and a `request.newContext()` or
// `playwright.request` context counts as a reader. A helper is not a blanket pass: a presence-only helper and a
// decorative read in a helper are still violations. The step is the real `gate.ts census-trend <base>` on a scratch
// repo, as in census-journey.test.ts.

afterEach(cleanupScratch)

const J = 'tests/e2e/journeys'
const S = 'tests/e2e/support'

/** The paths named on violation lines that carry `journey rule`, and those on the other violation lines. */
function violations(out: string): { journey: string[]; other: string[] } {
  const lines = out.split('\n').filter((l) => l.startsWith('violation:'))
  const path = (l: string): string => /(tests\/e2e\/journeys\/[\w./-]+\.spec\.ts)/.exec(l)?.[1] ?? l
  return {
    journey: [...new Set(lines.filter((l) => l.includes('journey rule')).map(path))].sort(),
    other: lines.filter((l) => !l.includes('journey rule')).map(path),
  }
}

/** The read and both assertions live in the helper; the context comes from `request.newContext()`. */
const SORT_HELPER = `import { expect, request, type Page } from '@playwright/test'

export async function assertGridFollowsApi(page: Page): Promise<void> {
  const api = await request.newContext()
  const response = await api.get('http://localhost:3001/api/products?sort=price')
  const body = await response.json()
  await page.goto('/products?sort=price')
  const names = await page.getByTestId('product-title').allTextContents()
  expect(names.length).toBeGreaterThan(0)
  expect(names).toEqual(body.items.map((p: { name: string }) => p.name))
}
`

/** Presence only: a helper that asserts nothing the API says. */
const PRESENCE_HELPER = `import { expect, type Page } from '@playwright/test'

export async function expectSortControl(page: Page): Promise<void> {
  await page.goto('/products')
  await expect(page.getByTestId('sort-dropdown')).toBeVisible()
}
`

/** A read in a helper that nothing asserts on. */
const DECORATIVE_HELPER = `import { request } from '@playwright/test'

export async function pingApi(): Promise<void> {
  const api = await request.newContext()
  await api.get('http://localhost:3001/api/health')
}
`

const FILES = {
  helperGood: `${J}/sort-through-helper.spec.ts`,
  playwrightRequest: `${J}/cart-through-playwright-request.spec.ts`,
  helperPresence: `${J}/sort-presence-helper.spec.ts`,
  helperDecorative: `${J}/checkout-decorative-helper.spec.ts`,
}

const JOURNEYS: Record<string, string> = {
  [FILES.helperGood]: `import { test } from '@playwright/test'
import { assertGridFollowsApi } from '../support/sort-order'

test('AC-1: the grid shows the products in the order the API returns', async ({ page }) => {
  await assertGridFollowsApi(page)
})
`,
  [FILES.playwrightRequest]: `import { expect, test } from '@playwright/test'

test('AC-2: the badge counts the lines the API holds', async ({ page, playwright }) => {
  const api = await playwright.request.newContext()
  const response = await api.get('http://localhost:3001/api/cart')
  const cart = await response.json()
  await page.goto('/cart')
  const badge = Number(await page.getByTestId('mini-cart-badge').textContent())
  expect(badge).toBe(cart.items.reduce((n: number, line: { quantity: number }) => n + line.quantity, 0))
})
`,
  [FILES.helperPresence]: `import { test } from '@playwright/test'
import { expectSortControl } from '../support/sort-control'

test('the sort control is there', async ({ page }) => {
  await expectSortControl(page)
})
`,
  [FILES.helperDecorative]: `import { expect, test } from '@playwright/test'
import { pingApi } from '../support/ping'

test('places an order', async ({ page }) => {
  await pingApi()
  await page.goto('/checkout')
  await page.getByTestId('place-order').click()
  const number = (await page.getByTestId('order-number').textContent()) ?? ''
  expect(number.length).toBeGreaterThan(4)
})
`,
}

describe('AC-12 (review finding 4): the journey rule counts imported support helpers', () => {
  it('AC-12: a read and assertions in an imported support helper, or a playwright.request context, pass; a presence-only or decorative helper still violates', async () => {
    const repo = scratchRepo({
      'package.json': JSON.stringify({ name: 'census-scratch', private: true }),
      [`${S}/sort-order.ts`]: SORT_HELPER,
      [`${S}/sort-control.ts`]: PRESENCE_HELPER,
      [`${S}/ping.ts`]: DECORATIVE_HELPER,
    })
    const base = git(repo.root, 'rev-parse', 'HEAD')
    for (const [path, text] of Object.entries(JOURNEYS)) write(repo.root, path, text)
    git(repo.root, 'add', '-A')
    git(repo.root, 'commit', '-q', '-m', 'journeys')

    const run = await gateCli(repo, ['census-trend', base], {}, false)
    const found = violations(run.output)

    expect(run.output).toMatch(
      new RegExp(`${Object.keys(JOURNEYS).length} test file\\(s\\) touched`),
    )
    expect(found.other, run.output).toEqual([])
    expect(found.journey, run.output).toEqual([FILES.helperPresence, FILES.helperDecorative].sort())
    expect(found.journey.length).toBeLessThan(Object.keys(JOURNEYS).length)
  })

  it('AC-12: the real admin/csrf-preflight.spec.ts, judged as touched, has no journey violation', async () => {
    const real = (path: string): string => readFileSync(join(REPO, path), 'utf8')
    const spec = `${J}/admin/csrf-preflight.spec.ts`
    const repo = scratchRepo({
      'package.json': JSON.stringify({ name: 'census-scratch', private: true }),
      [`${S}/csrf-preflight.ts`]: real(`${S}/csrf-preflight.ts`),
      [`${S}/csrf.ts`]: real(`${S}/csrf.ts`),
      [`${S}/fixtures.ts`]: real(`${S}/fixtures.ts`),
    })
    const base = git(repo.root, 'rev-parse', 'HEAD')
    write(repo.root, spec, real(spec))
    git(repo.root, 'add', '-A')
    git(repo.root, 'commit', '-q', '-m', 'the real csrf preflight journey')

    const run = await gateCli(repo, ['census-trend', base], {}, false)
    const found = violations(run.output)

    // Judged: the census counts it as a touched file, so a missing violation is not a skipped file.
    expect(run.output).toMatch(/: 1 test file\(s\) touched/)
    expect(found.journey, run.output).toEqual([])
    expect(found.other, run.output).toEqual([])
    expect(run.code, run.output).toBe(0)
  })
})
