import { expect, test } from '../support/fixtures'

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
    await page.goto('/products')
    await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible({ timeout: 15000 })
    const filterGroups = page.locator('[data-testid^="filter-group-"]')
    if (await filterGroups.count() > 0) {
      const checkbox = filterGroups.first().locator('input[type="checkbox"]').first()
      await checkbox.click()
      await page.waitForTimeout(800)
    }
  })

  test('filter round-trip: apply filter then remove restores original product count and all filter groups remain visible', async ({ page }) => {
    await page.goto('/products')
    await expect(page.locator('[data-testid^="product-card-"]').first()).toBeVisible({ timeout: 15000 })

    const filterGroups = page.locator('[data-testid^="filter-group-"]')
    const filterGroupCount = await filterGroups.count()
    if (filterGroupCount === 0) {
      // No filters on this template — skip gracefully
      return
    }

    // Capture original product count
    const originalProductCount = await page.locator('[data-testid^="product-card-"]').count()
    expect(originalProductCount).toBeGreaterThan(0)

    // Click the first available filter checkbox
    const firstCheckbox = filterGroups.first().locator('input[type="checkbox"]').first()
    await firstCheckbox.click()
    await page.waitForTimeout(1000)

    // Products updated — count should be >= 0 (never nothing unless genuinely empty)
    const filteredCount = await page.locator('[data-testid^="product-card-"]').count()
    // All filter groups remain visible after filtering
    await expect(filterGroups.first()).toBeVisible()

    // Unclick filter — should restore original state
    await firstCheckbox.click()
    await page.waitForTimeout(1000)

    const restoredCount = await page.locator('[data-testid^="product-card-"]').count()
    expect(restoredCount).toBe(originalProductCount)

    // All filter groups still visible
    expect(await filterGroups.count()).toBe(filterGroupCount)
  })
})
