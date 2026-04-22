// Re-export the canonical seed fixtures from the platform package.
// Tests that need deterministic commerce data can import from here.
export { seedCategories, seedProducts } from '@nymbal/platform'
export type { SeedCategory, SeedProduct } from '@nymbal/platform'
