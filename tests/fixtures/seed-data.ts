// Re-export the canonical seed fixtures from the platform package.
// Tests that need deterministic commerce data can import from here.
export { seedCategories, seedProducts } from '@nymbalhq/platform'
export type { SeedCategory, SeedProduct } from '@nymbalhq/platform'
