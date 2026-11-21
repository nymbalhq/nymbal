import type { APIRequestContext, Browser, Page } from '@playwright/test'
import { signInAsAdmin } from '../support/admin'
import { mailbox } from '../support/alerts'
import { isCustomProject, storeCapabilities } from '../support/capabilities'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { apiSignInStatus, newShopper } from '../support/passwords'
import {
  isVerifyMail,
  registerPending,
  registerVerified,
  verificationOf,
  verifyTokenIn,
} from '../support/verification'

// Support rescues a shopper whose confirmation mail went missing, from the customer's admin page on the store whose
// email reaches Mailpit (@capabilities; the native store confirms nobody, so its customers show no panel). A shopper
// registered through the API is waiting to confirm: their admin page shows the panel; sending the link again puts one
// more confirmation in Mailpit and the older link stops working; marking them confirmed lets their password sign in;
// a confirmed customer's page shows no panel.

const ADMIN_BASE = `${API_URL}/admin/`
// The admin's test ids carry its `admin-` prefix (src/lib/testid.ts); the panel is named by what follows it.
const PANEL = '[data-testid$="customer-verification"]'
const SEND = '[data-testid$="customer-send-verification"]'
const MARK = '[data-testid$="customer-mark-verified"]'

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function customerIdOf(request: APIRequestContext, token: string, email: string): Promise<string> {
  const res = await request.get(
    `${API_URL}/api/admin/customers?q=${encodeURIComponent(email)}&limit=200`,
    { headers: auth(token) },
  )
  const found = ((await res.json()) as { data: { customers: Array<{ id: string; email: string }> } }).data.customers
  const match = found.filter((c) => c.email === email)
  expect(match.length, `customers listed at ${email}`).toBe(1)
  return match[0]!.id
}

/** The admin, signed in on a browser of its own, on the customer's page once it has loaded. */
async function adminOnCustomer(browser: Browser, customerId: string): Promise<Page> {
  const admin = await (await browser.newContext()).newPage()
  await signInAsAdmin(admin, ADMIN_BASE)
  await admin.goto(new URL(`customers/${encodeURIComponent(customerId)}`, ADMIN_BASE).href)
  await expect(admin.getByTestId('admin-customer-detail')).toBeVisible({ timeout: 15_000 })
  return admin
}

const isAction = (action: string) => (res: { url(): string; request(): { method(): string } }) =>
  res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith(`/${action}`)

test.describe('rescuing an unconfirmed sign-up', () => {
  test('AC-24: a pending shopper’s admin page shows the confirmation panel; sending the link again mails one more and refuses the older link; marking them confirmed lets their password sign in, and their page then shows no panel (on a store that does not confirm, a new customer’s page shows none) @capabilities', async ({
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000)
    const caps = await storeCapabilities(request)
    const confirming = isCustomProject(testInfo.project.name)
    expect(verificationOf(caps), JSON.stringify(caps)).toBe(confirming ? 'required' : 'off')
    const token = await adminToken(request)
    const shopper = newShopper('rescue')

    if (!confirming) {
      await registerVerified(shopper)
      const admin = await adminOnCustomer(browser, await customerIdOf(request, token, shopper.email))
      await expect(admin.locator(PANEL)).toHaveCount(0)
      await admin.context().close()
      return
    }

    const firstToken = await registerPending(shopper)
    const customerId = await customerIdOf(request, token, shopper.email)
    const admin = await adminOnCustomer(browser, customerId)
    await expect(admin.locator(PANEL)).toBeVisible({ timeout: 10_000 })

    const mail = await mailbox()
    const before = (await mail.messages(shopper.email)).filter(isVerifyMail).length
    const sendAnswer = admin.waitForResponse(isAction('send-verification'))
    await admin.locator(SEND).click()
    expect((await sendAnswer).status(), 'the send-verification POST').toBe(202)
    const mails = (await mail.waitFor(shopper.email, before + 1)).filter(isVerifyMail)
    const tokens = mails.map(verifyTokenIn)
    const oldLink = await request.post(`${API_URL}/api/auth/verify-email`, {
      headers: await csrf(request),
      data: { token: firstToken },
    })

    expect(tokens.length, 'confirmation mails after the send').toBe(before + 1)
    expect(tokens.filter((t) => t !== firstToken).length, 'a new link').toBe(1)
    expect(oldLink.status(), 'the older link after the send').toBe(400)

    const refusedBefore = await apiSignInStatus(shopper.email, shopper.password)
    const markAnswer = admin.waitForResponse(isAction('mark-verified'))
    await admin.locator(MARK).click()
    expect((await markAnswer).status(), 'the mark-verified POST').toBe(200)

    expect([refusedBefore, await apiSignInStatus(shopper.email, shopper.password)]).toEqual([401, 200])
    await admin.reload()
    await expect(admin.getByTestId('admin-customer-detail')).toBeVisible({ timeout: 15_000 })
    await expect(admin.locator(PANEL)).toHaveCount(0)
    await admin.context().close()
  })
})
