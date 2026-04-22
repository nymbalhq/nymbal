import { expect, test } from '@playwright/test';
test('storefront renders a product list', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Any product card should render — we seed 24.
    const cards = page.locator('li');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
});
//# sourceMappingURL=storefront.spec.js.map