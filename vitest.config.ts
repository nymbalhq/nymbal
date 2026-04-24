import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'platform-unit',
          environment: 'node',
          include: ['packages/platform/src/**/*.test.ts'],
          exclude: ['packages/platform/tests/**'],
        },
      },
      {
        test: {
          name: 'platform-integration',
          environment: 'node',
          include: ['packages/platform/tests/integration/**/*.test.ts'],
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'sdk',
          environment: 'node',
          include: ['packages/sdk/src/**/*.test.ts', 'packages/sdk/tests/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web-components',
          environment: 'happy-dom',
          include: ['packages/web-components/src/**/*.test.ts'],
          setupFiles: ['packages/web-components/tests/setup.ts'],
          pool: 'forks',
          isolate: true,
        },
      },
      {
        test: {
          name: 'react',
          environment: 'jsdom',
          include: ['packages/react/src/**/*.test.tsx', 'packages/react/src/**/*.test.ts'],
          setupFiles: ['packages/react/tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'contracts-native',
          environment: 'node',
          include: ['tests/contracts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'templates',
          environment: 'node',
          include: ['templates/*/tests/**/*.test.ts', 'templates/*/tests/**/*.test.tsx'],
        },
      },
      {
        test: {
          name: 'factories',
          environment: 'node',
          include: ['packages/test-factories/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'config',
          environment: 'node',
          include: ['packages/config/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'types',
          environment: 'node',
          include: ['packages/types/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'importers-unit',
          environment: 'node',
          include: [
            'packages/importers/tests/mappers/**/*.test.ts',
            'packages/importers/tests/client.test.ts',
            'packages/importers/tests/enrichment.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'importers-integration',
          environment: 'node',
          include: ['packages/importers/tests/integration/**/*.test.ts'],
          testTimeout: 60000,
        },
      },
      {
        test: {
          name: 'admin',
          environment: 'jsdom',
          include: ['apps/admin/src/**/*.test.{ts,tsx}'],
          setupFiles: ['apps/admin/src/tests/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: [
        '**/generated/**',
        '**/*.generated.ts',
        '**/*.d.ts',
        '**/dist/**',
        'packages/*/src/index.ts',
        '**/tests/**',
        'packages/test-factories/**',
        'packages/contract-tests/**',
      ],
      thresholds: {
        'packages/platform/src/services/**': { lines: 100 },
        'packages/platform/src/utils/**': { lines: 100 },
      },
    },
  },
})
