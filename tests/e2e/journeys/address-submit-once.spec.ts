import { randomUUID } from 'node:crypto'
import type { Page, Response } from '@playwright/test'
import { expect, test } from '../support/fixtures'
import { API_URL } from '../support/csrf'

// AC-2: on Astro, a signed-in shopper who double-clicks Save on the add-address form makes one address. Runs on the
// astro project only.

const ADDRESSES_ROUTE = '/api/customers/me/addresses'
// The SDK's localStorage key for the access token (`packages/sdk/src/auth/token-manager.ts`).
const TOKEN_KEY = 'nymbal.auth.accessToken'

/** Registers through the storefront's own form, so the token is wherever the template keeps it. */
async function registerShopper(page: Page): Promise<{ firstName: string }> {
  const tag = randomUUID().slice(0, 8)
  const firstName = `Ada${tag}`
  await page.goto('/account/register')
  const form = page.getByTestId('register-form')
  await form.getByTestId('register-firstName').fill(firstName)
  await form.getByTestId('register-lastName').fill('Once')
  await form.getByTestId('register-email').fill(`submit-${tag}@e2e.test`)
  await form.getByTestId('register-password').fill('TestPassword123!')
  await form.getByTestId('register-confirmPassword').fill('TestPassword123!')
  await form.getByTestId('register-submit').click()
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
    timeout: 15_000,
  })
  return { firstName }
}

type Stored = { data: Array<{ addressLine1: string }> }

test('AC-2: double-clicking Save on the Astro add-address form grows the stored addresses by exactly one, and the page lists that one', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'astro',
    'the Astro defect; standing.submit-once-nextjs already holds on Next',
  )
  test.setTimeout(60_000)
  const shopper = await registerShopper(page)
  const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)
  if (token === null) throw new Error(`no ${TOKEN_KEY} in localStorage after registering`)
  // The customer's addresses as the API stores them, read with the token the storefront holds.
  const auth = { headers: { Authorization: `Bearer ${token}` } }
  const beforeRes = await page.request.get(`${API_URL}/api/customers/me/addresses`, auth)
  if (!beforeRes.ok()) throw new Error(`GET ${ADDRESSES_ROUTE} answered ${beforeRes.status()}`)
  const before = ((await beforeRes.json()) as Stored).data.length

  await page.goto('/account/addresses')
  // The page's module script attaches the submit handler by `load`; a click before then submits natively.
  await page.waitForLoadState('load')
  const list = page.getByTestId('addresses-list')
  await expect(list).not.toContainText('Loading addresses', { timeout: 10_000 })

  const line1 = `${randomUUID().slice(0, 6)} Once Lane`
  const form = page.getByTestId('add-address-form')
  await form.getByTestId('new-address-firstName').fill(shopper.firstName)
  await form.getByTestId('new-address-lastName').fill('Once')
  await form.getByTestId('new-address-addressLine1').fill(line1)
  await form.getByTestId('new-address-city').fill('London')
  await form.getByTestId('new-address-region').fill('Greater London')
  await form.getByTestId('new-address-postalCode').fill('SW1 1AA')
  await form.getByTestId('new-address-country').fill('GB')

  const creates: Array<Promise<Response | null>> = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === ADDRESSES_ROUTE) {
      creates.push(req.response())
    }
  })
  await form.getByTestId('save-address').dblclick()
  await expect(list).toContainText(line1, { timeout: 10_000 })
  // Every create the double click sent has been answered before the store is read.
  await Promise.all(creates)

  const afterRes = await page.request.get(`${API_URL}/api/customers/me/addresses`, auth)
  const after = (await afterRes.json()) as Stored
  expect(after.data.length).toBe(before + 1)

  await page.reload({ waitUntil: 'load' })
  await expect(list.locator('[data-testid^="address-"]').filter({ hasText: line1 })).toHaveCount(
    1,
    { timeout: 10_000 },
  )
})
