import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/fixtures'
import {
  apiSignInStatus,
  FORGOT_PATH,
  newShopper,
  plantResetLink,
  registerThroughApi,
  requestsTo,
  RESET_PATH,
} from '../support/passwords'
import { formReady, signIn } from '../support/sign-in'

// A double click on the submit of the forgot, reset and change forms sends one request and makes one change, on both
// storefronts: at most one request leaves the page, and what it answered (the 202, the sign-in, the new password)
// shows that one did. The reset page is opened with a link planted in the running store, so the journey needs no mail.

const onAccountHome = (url: URL) => url.pathname.replace(/\/$/, '') === '/account'

/** Double-clicks `submit` and answers how many `method path` requests the page sent once it has settled. */
async function doubleClicked(
  page: Page,
  submit: string,
  method: string,
  path: string,
): Promise<number> {
  const sent = requestsTo(page, method, path)
  try {
    await page.getByTestId(submit).dblclick()
    await page.waitForLoadState('networkidle')
    return sent.count()
  } finally {
    sent.stop()
  }
}

test.describe('Password forms submit once', () => {
  test('AC-26: a double click on Send reset link sends one forgot request and shows forgot-sent', async ({
    page,
  }) => {
    await page.goto(FORGOT_PATH)
    await formReady(page, 'nymbal-forgot-password-form')
    await page.getByTestId('forgot-email').fill(`once-${randomUUID().slice(0, 8)}@e2e.test`)
    const answered = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/auth/forgot-password',
    )

    const requests = await doubleClicked(page, 'forgot-submit', 'POST', '/api/auth/forgot-password')

    expect(requests, 'requests for two clicks').toBeLessThanOrEqual(1)
    expect((await answered).status()).toBe(202)
    await expect(page.getByTestId('forgot-sent')).toBeVisible()
  })

  test('AC-26: a double click on Set password sends one reset request, signs the shopper in, and the new password is the one that signs in', async ({
    page,
  }) => {
    const shopper = newShopper('reset-once')
    await registerThroughApi(shopper)
    const token = await plantResetLink(shopper.email)
    const next = `Once-${randomUUID().slice(0, 8)}-Password`
    await page.goto(`${RESET_PATH}#token=${token}`)
    await formReady(page, 'nymbal-reset-password-form')
    await page.getByTestId('reset-password').fill(next)

    const requests = await doubleClicked(page, 'reset-submit', 'POST', '/api/auth/reset-password')

    expect(requests, 'requests for two clicks').toBeLessThanOrEqual(1)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    expect([
      await apiSignInStatus(shopper.email, next),
      await apiSignInStatus(shopper.email, shopper.password),
    ]).toEqual([200, 401])
  })

  test('AC-26: a double click on Change password sends one change request and the new password is the one that signs in', async ({
    page,
  }) => {
    const shopper = newShopper('change-once')
    await registerThroughApi(shopper)
    await signIn(page, shopper.email, shopper.password)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    await page.goto('/account/profile')
    await formReady(page, 'nymbal-change-password-form')
    const next = `Once-${randomUUID().slice(0, 8)}-Password`
    await page.getByTestId('change-current').fill(shopper.password)
    await page.getByTestId('change-new').fill(next)

    const requests = await doubleClicked(
      page,
      'change-submit',
      'PATCH',
      '/api/customers/me/password',
    )

    expect(requests, 'requests for two clicks').toBeLessThanOrEqual(1)
    await expect(page.getByTestId('change-done')).toBeVisible()
    expect([
      await apiSignInStatus(shopper.email, next),
      await apiSignInStatus(shopper.email, shopper.password),
    ]).toEqual([200, 401])
  })
})
