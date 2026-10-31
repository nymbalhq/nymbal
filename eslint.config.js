import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'
import vitest from '@vitest/eslint-plugin'
import playwright from 'eslint-plugin-playwright'

// A test server bound to `localhost` listens on ::1 or 127.0.0.1 by the resolver's answer, and a client told
// `localhost` may take the other: a test red at two commits in two checkouts over this was rerun green each time.
// Tests bind an address and point their clients at it.
const LISTEN_LOCALHOST = [
  {
    selector: "CallExpression[callee.property.name='listen'] > Literal[value='localhost']",
    message: "Tests listen on 127.0.0.1 (or ::1) and name that address, not 'localhost'.",
  },
  {
    selector:
      "CallExpression[callee.property.name='listen'] > ObjectExpression > Property[key.name='host'] > Literal[value='localhost']",
    message: "Tests listen on 127.0.0.1 (or ::1) and name that address, not 'localhost'.",
  },
]

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.astro/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { vitest },
    rules: {
      'vitest/expect-expect': 'error',
      'vitest/no-conditional-expect': 'error',
    },
  },
  {
    files: ['tests/e2e/journeys/**/*.spec.ts'],
    plugins: { playwright },
    rules: {
      'playwright/no-wait-for-timeout': 'error',
      'playwright/prefer-web-first-assertions': 'error',
    },
  },
  // E2E and scaffold tests reach the store through its own surface: a test that posts the payment webhook proves a
  // confirmation the product never gives. Kernel tests and the contract suites drive the hook on purpose.
  {
    files: ['tests/e2e/**/*.ts', 'tests/scaffold/**/*.ts', 'tests/scaffold-image/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nymbalhq/proof-kit',
              importNames: ['stubPaymentWebhook', 'finaliseStubPayment'],
              message:
                'E2E and scaffold tests confirm payment through the product, not the payment hook.',
            },
          ],
        },
      ],
      // / is "/": an esquery regex literal cannot hold a slash.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\u002Fapi\\u002Fwebhooks\\u002F/]',
          message: 'E2E and scaffold tests do not call /api/webhooks/; drive the product instead.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\u002Fapi\\u002Fwebhooks\\u002F/]',
          message: 'E2E and scaffold tests do not call /api/webhooks/; drive the product instead.',
        },
        ...LISTEN_LOCALHOST,
      ],
    },
  },
  // Every other test path (the hooks' notion of one: a test file, or anything under tests/, fixtures/, __tests__/,
  // journeys/ or sentinels/); the E2E and scaffold block above carries the same selectors beside its own.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.test-d.ts',
      'tests/**/*.ts',
      '**/__tests__/**/*.ts',
      '**/__fixtures__/**/*.ts',
      '**/fixtures/**/*.ts',
      '**/journeys/**/*.ts',
      '**/sentinels/**/*.ts',
    ],
    ignores: ['tests/e2e/**', 'tests/scaffold/**', 'tests/scaffold-image/**'],
    rules: {
      'no-restricted-syntax': ['error', ...LISTEN_LOCALHOST],
    },
  },
  prettier,
]
