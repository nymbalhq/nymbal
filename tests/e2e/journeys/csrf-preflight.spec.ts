import { test } from '@playwright/test'
import { assertCsrfEnforced, unpublishedNewest } from '../support/csrf-preflight'

// AC-10: the storefront journeys run against an API with CSRF on, so their passing means the templates send the
// token.

test('AC-10: a bare POST /api/cart/items from a fresh request context answers 403 csrf.invalid, and the same write with the GET /api/csrf pair succeeds', async () => {
  await assertCsrfEnforced()
})

test('AC-4: with a product unpublished after it was listed, newest and in stock, the preflight takes the first in-stock variant the list serves and the paired cart write succeeds', async () => {
  await unpublishedNewest()
  await assertCsrfEnforced()
})
