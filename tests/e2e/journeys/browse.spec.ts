import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../support/fixtures'

/**
 * Opens the PLP and waits until the client's own product load has answered, so a filter clicked next is not
 * overtaken by that load's response (the product-list store keeps whichever response lands last).
 */
async function openListing(page: Page): Promise<Locator> {
  const listed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/products' && r.request().method() === 'GET',
  )
  await page.goto('/products')
  await listed
  const cards = page.locator('[data-testid^="product-card-"]')
  await expect(cards.first()).toBeVisible({ timeout: 15000 })
  return cards
}

/** How many products a filter option says it matches, from its "(n)" count. */
async function facetCount(option: Locator): Promise<number> {
  const count = option.locator('.nymbal-filter-count')
  await expect(count).toHaveText(/^\(\d+\)$/)
  return Number((await count.textContent())!.replace(/\D/g, ''))
}

test.describe('Browse catalog', () => {
  test('homepage shows hero and product cards', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="hero-section"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible()
  })

  test('PLP shows product grid and sort dropdown', async ({ page }) => {
    await page.goto('/products')
    await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="sort-dropdown"]')).toBeVisible()
  })

  test('PDP shows product title and add-to-cart button', async ({ page }) => {
    await page.goto('/products')
    const firstCard = page.locator('[data-testid^="product-card-"]').first()
    await firstCard.click()
    await expect(page.locator('[data-testid="product-title"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="add-to-cart"]')).toBeVisible()
  })

  test('breadcrumb is visible on PDP', async ({ page }) => {
    await page.goto('/products')
    await page.locator('[data-testid^="product-card-"]').first().click()
    await expect(page.locator('[data-testid="breadcrumb"]')).toBeVisible({ timeout: 15000 })
  })

  test('stock badge is visible on PDP', async ({ page }) => {
    await page.goto('/products')
    await page.locator('[data-testid^="product-card-"]').first().click()
    await expect(page.locator('[data-testid="stock-badge"]')).toBeVisible({ timeout: 15000 })
  })

  test('product listing shows at least 4 products', async ({ page }) => {
    await page.goto('/products')
    const cards = page.locator('[data-testid^="product-card-"]')
    await expect(cards.first()).toBeVisible({ timeout: 15000 })
    const count = await cards.count()
    expect(count).toBeGreaterThanOrEqual(4)
  })

  test('product filters are clickable and do not crash', async ({ page }) => {
    const cards = await openListing(page)
    const option = page.locator('[data-testid^="filter-group-"] [data-testid^="filter-option-"]').first()
    const expected = Math.min(await facetCount(option), await cards.count())
    const checkbox = option.locator('input[type="checkbox"]')
    await checkbox.click()
    // The listing reloads to the filtered set, and the filter shows itself applied.
    await expect(cards).toHaveCount(expected)
    await expect(checkbox).toBeChecked()
  })

  test('filter round-trip: apply filter then remove restores original product count and all filter groups remain visible', async ({ page }) => {
    const cards = await openListing(page)
    const filterGroups = page.locator('[data-testid^="filter-group-"]')
    await expect(filterGroups.first()).toBeVisible()
    const filterGroupCount = await filterGroups.count()

    // Capture original product count
    const originalProductCount = await cards.count()
    expect(originalProductCount).toBeGreaterThan(0)

    // Apply the first filter: the listing narrows to the products the option says it matches (at most one page).
    const firstOption = filterGroups.first().locator('[data-testid^="filter-option-"]').first()
    const filteredCount = Math.min(await facetCount(firstOption), originalProductCount)
    const firstCheckbox = firstOption.locator('input[type="checkbox"]')
    await firstCheckbox.click()
    await expect(cards).toHaveCount(filteredCount)
    // All filter groups remain visible after filtering
    await expect(filterGroups).toHaveCount(filterGroupCount)

    // Unclick filter — the original listing comes back
    await firstCheckbox.click()
    await expect(firstCheckbox).not.toBeChecked()
    await expect(cards).toHaveCount(originalProductCount)

    // All filter groups still visible
    await expect(filterGroups).toHaveCount(filterGroupCount)
  })

  test('clicking filter keeps all category options visible', async ({ page }) => {
    const cards = await openListing(page)

    const filterOptions = page.locator('[data-testid^="filter-option-"]')
    // At least two options, so that one stays unselected
    await expect(filterOptions.nth(1)).toBeVisible()
    const countBefore = await filterOptions.count()
    const first = filterOptions.first()
    const expected = Math.min(await facetCount(first), await cards.count())

    // Click first filter option and wait for the filtered listing
    await first.click()
    await expect(cards).toHaveCount(expected)

    // All filter options still visible (count must not decrease)
    await expect(filterOptions).toHaveCount(countBefore)
  })
})
