import { test } from '@playwright/test'
import { assertCsrfEnforced } from '../support/csrf-preflight'

// AC-10: the storefront journeys run against an API with CSRF on, so their passing means the templates send the
// token.

test('AC-10: a bare POST /api/cart/items from a fresh request context answers 403 csrf.invalid, and the same write with the GET /api/csrf pair succeeds', async () => {
  await assertCsrfEnforced()
})
