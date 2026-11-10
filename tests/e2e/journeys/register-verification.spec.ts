import { randomBytes, randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { mailbox } from '../support/alerts'
import { isCustomProject, storeCapabilities } from '../support/capabilities'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { apiSignInStatus, newShopper, requestsTo, type Shopper } from '../support/passwords'
import { formReady, signIn } from '../support/sign-in'
import {
  forgotThroughApi,
  isAccountExistsMail,
  isVerifyMail,
  registerPending,
  registerVerified,
  verificationOf,
  VERIFY_PATH,
  verifyTokenIn,
} from '../support/verification'

// Sign-up on both storefronts, by the policy GET /api/capabilities reports (@capabilities). Where it is `off` (the
// native stores) the register form signs the shopper in at once. Where it is `required` (the Mailpit stores) the form
// answers every address with the same "we sent a link" note and no session; a new address gets one confirmation mail
// and an existing account one "you already have an account" mail; the link survives a scanner's fetch, signs the
// shopper in once on a press, and the password then signs in. The sign-in page links to a page that sends the link
// again, which answers an unknown and a pending address alike.

const onPath = (path: string) => (url: URL) => url.pathname.replace(/\/$/, '') === path
const onAccountHome = onPath('/account')

/** The policy the project's store must report: the Mailpit stores confirm, the native ones do not. */
async function policyOf(
  request: Parameters<typeof storeCapabilities>[0],
  projectName: string,
): Promise<'required' | 'off'> {
  const caps = await storeCapabilities(request)
  const expected = isCustomProject(projectName) ? 'required' : 'off'
  expect(verificationOf(caps), JSON.stringify(caps)).toBe(expected)
  return expected
}

/** Fills and submits the register form on a fresh /account/register for `shopper`. */
async function submitRegisterForm(page: Page, shopper: Shopper): Promise<void> {
  await page.goto('/account/register')
  await formReady(page, 'nymbal-register-form')
  const form = page.locator('nymbal-register-form')
  await form.getByLabel('First Name', { exact: true }).fill('Ada')
  await form.getByLabel('Last Name', { exact: true }).fill('Verify')
  await form.getByTestId('register-email').fill(shopper.email)
  const passwords = form.locator('input[type="password"]')
  for (let i = 0; i < (await passwords.count()); i += 1)
    await passwords.nth(i).fill(shopper.password)
  await form.getByTestId('register-submit').click()
}

/** Registers through the form and answers the register-sent note's text with the address put as <address>. */
async function registerSentText(page: Page, shopper: Shopper): Promise<string> {
  await submitRegisterForm(page, shopper)
  const sent = page.getByTestId('register-sent')
  await expect(sent).toBeVisible({ timeout: 15_000 })
  const text = (await sent.innerText()).trim()
  expect(text, 'register-sent names the typed address').toContain(shopper.email)
  return text.split(shopper.email).join('<address>')
}

/** Asks for the link again for `email` on the open verify page; answers the text the page then shows. */
async function askResend(page: Page, email: string): Promise<string> {
  await formReady(page, 'nymbal-verify-email')
  await page.getByTestId('resend-email').fill(email)
  await page.getByTestId('resend-submit').click()
  const sent = page.getByTestId('resend-sent')
  await expect(sent).toBeVisible({ timeout: 10_000 })
  return (await sent.innerText()).trim()
}

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

test.describe('Sign-up confirmation', () => {
  test('AC-18: by the store’s policy, the register form signs in at once (off), or answers a new, a repeated and a confirmed address with the same note and no session, mails one link and one account-exists notice, and the link survives a scanner’s fetch, signs the shopper in once on a press, and the password then signs in (required) @capabilities', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(150_000)
    const policy = await policyOf(request, testInfo.project.name)
    const shopper = newShopper('verify-journey')

    if (policy === 'off') {
      await submitRegisterForm(page, shopper)
      await page.waitForURL(onAccountHome, { timeout: 15_000 })
      expect(await apiSignInStatus(shopper.email, shopper.password)).toBe(200)
      return
    }

    const existing = newShopper('verify-existing')
    await registerVerified(existing)
    const notes = [
      await registerSentText(page, shopper),
      await registerSentText(page, shopper),
      await registerSentText(page, {
        email: existing.email,
        password: `Other-${randomUUID().slice(0, 8)}`,
      }),
    ]
    const refreshed = await page.request.post(`${API_URL}/api/auth/refresh`, {
      headers: await csrf(page.request),
    })
    const profile = await page.request.get(`${API_URL}/api/customers/me`)
    const refreshCookies = (await page.context().cookies()).filter(
      (c) => c.name === 'nymbal.refresh',
    )

    expect(notes).toEqual([notes[0], notes[0], notes[0]])
    expect([refreshed.status(), profile.status(), refreshCookies]).toEqual([401, 401, []])

    // A reset request after the registers: once its mail has landed, every mail the registers sent has too.
    await forgotThroughApi(shopper.email)
    await forgotThroughApi(existing.email)
    const mail = await mailbox()
    const toShopper = await mail.waitFor(shopper.email, 2)
    const toExisting = await mail.waitFor(existing.email, 3)
    expect(toShopper.filter(isVerifyMail).length, 'confirmation mails to the new address').toBe(1)
    expect(toShopper.filter(isAccountExistsMail).length, 'notices to the new address').toBe(0)
    expect(toExisting.filter(isAccountExistsMail).length, 'notices to the existing account').toBe(1)
    expect(
      toExisting.filter(isVerifyMail).length,
      'confirmation mails to the existing account',
    ).toBe(1)

    const token = verifyTokenIn(toShopper.find(isVerifyMail)!)
    // The store mails one storefront's URL; the journey opens the link's path and fragment on this project's own.
    const here = `${VERIFY_PATH}#token=${token}`
    // A mail scanner fetches the link without running the page: the token is in the fragment, which it never sends.
    const scanned = await request.get(VERIFY_PATH)
    expect(scanned.status(), 'the scanner gets the page, not an error').toBeLessThan(400)

    const signedIn = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/customers/me' && res.status() === 200,
      { timeout: 15_000 },
    )
    await page.goto(here)
    await formReady(page, 'nymbal-verify-email')
    await page.getByTestId('verify-submit').click()
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    expect((await signedIn).status()).toBe(200)

    await page.goto(here)
    await formReady(page, 'nymbal-verify-email')
    await page.getByTestId('verify-submit').click()
    await expect(page.getByTestId('verify-invalid')).toBeVisible({ timeout: 10_000 })

    const baseURL = testInfo.project.use.baseURL
    const fresh = await (
      await browser.newContext({ ...(baseURL !== undefined && { baseURL }) })
    ).newPage()
    try {
      await signIn(fresh, shopper.email, shopper.password)
      await fresh.waitForURL(onAccountHome, { timeout: 15_000 })
    } finally {
      await fresh.context().close()
    }
    expect(await apiSignInStatus(shopper.email, shopper.password)).toBe(200)
  })

  test('AC-19: the sign-in page links to the resend page exactly where the store confirms sign-ups; there, a resend for an unknown address and for a freshly registered pending one show one text, and the pending one gets no second mail @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const policy = await policyOf(request, testInfo.project.name)

    await page.goto('/account/login')
    await formReady(page, 'nymbal-login-form')
    await expect(page.getByTestId('forgot-password-link')).toBeVisible()
    const link = page.getByTestId('verify-resend-link')

    if (policy === 'off') {
      await expect(link).toHaveCount(0)
      return
    }

    await expect(link).toHaveText(/Didn.t get the confirmation email\?/)
    await link.click()
    await page.waitForURL(onPath(VERIFY_PATH), { timeout: 10_000 })
    const unknownText = await askResend(page, `nobody-${randomUUID().slice(0, 8)}@e2e.test`)
    const pending = newShopper('resend-pending')
    await registerPending(pending)
    await page.goto(VERIFY_PATH)
    const pendingText = await askResend(page, pending.email)

    expect(pendingText).toBe(unknownText)
    // The link is under 15 minutes old, so the resend mails nothing: once the reset mail asked after it has landed,
    // the address holds the one confirmation.
    await forgotThroughApi(pending.email)
    const mails = await (await mailbox()).waitFor(pending.email, 2)
    expect(mails.filter(isVerifyMail).length, 'confirmation mails to the pending address').toBe(1)
  })

  test('AC-20: a double click on verify-submit and on resend-submit sends one request each @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const policy = await policyOf(request, testInfo.project.name)
    // A pending account's mailed link where the store confirms; elsewhere a token the store never issued.
    const token =
      policy === 'required'
        ? await registerPending(newShopper('verify-once'))
        : randomBytes(32).toString('base64url')

    await page.goto(`${VERIFY_PATH}#token=${token}`)
    await formReady(page, 'nymbal-verify-email')
    const verifies = await doubleClicked(page, 'verify-submit', 'POST', '/api/auth/verify-email')

    expect(verifies, 'verify requests for two clicks').toBe(1)
    if (policy === 'required') await page.waitForURL(onAccountHome, { timeout: 15_000 })
    else await expect(page.getByTestId('verify-invalid')).toBeVisible({ timeout: 10_000 })

    await page.goto(VERIFY_PATH)
    await formReady(page, 'nymbal-verify-email')
    await page.getByTestId('resend-email').fill(`once-${randomUUID().slice(0, 8)}@e2e.test`)
    const resends = await doubleClicked(
      page,
      'resend-submit',
      'POST',
      '/api/auth/resend-verification',
    )

    expect(resends, 'resend requests for two clicks').toBe(1)
    await expect(page.getByTestId('resend-sent')).toBeVisible()
  })
})
