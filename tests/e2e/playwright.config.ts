import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './journeys',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4321',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'astro',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:4321',
      },
    },
    {
      name: 'nextjs',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.NYMBAL_STOREFRONT_URL ?? 'http://localhost:3000',
      },
    },
  ],
})
