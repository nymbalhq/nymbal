import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { linksIn, linkTo, mailbox } from '../support/alerts'
import { isCustomProject, storeCapabilities, type StoreCapabilities } from '../support/capabilities'
import { expect, test } from '../support/fixtures'
import { apiSignInStatus, FORGOT_PATH, newShopper, RESET_PATH } from '../support/passwords'
import { formReady } from '../support/sign-in'
import { registerVerified } from '../support/verification'

// "Forgot password?" on both storefronts. The journey reads GET /api/capabilities and asserts the branch it reports
// (@capabilities): on every store the sign-in page links to the forgot page, which a signed-out shopper reaches, and
// which answers an unknown address and a registered one with the same text. Where the store mails (the Mailpit
// store), the journey goes on with the link in the mail: a plain fetch of it, as a mail scanner makes, leaves it
// usable; it sets a password and lands on the account signed in; the same link then fails; the new password signs in
// and the old one is refused.

const onPath = (path: string) => (url: URL) => url.pathname.replace(/\/$/, '') === path
const onAccountHome = onPath('/account')

/** Whether the report says the store's email delivers; a report without the field reads as no answer. */
function delivers(caps: StoreCapabilities): unknown {
  return (caps as { email?: { delivers?: unknown } }).email?.delivers
}

/** Asks for a link for `email` on the open forgot page; answers the text the page then shows. */
async function askForLink(page: Page, email: string): Promise<string> {
  await formReady(page, 'nymbal-forgot-password-form')
  const form = page.locator('nymbal-forgot-password-form')
  await form.getByTestId('forgot-email').fill(email)
  await form.getByTestId('forgot-submit').click()
  const sent = form.getByTestId('forgot-sent')
  await expect(sent).toBeVisible({ timeout: 10_000 })
  return (await sent.innerText()).trim()
}

/** Sets `password` on the open reset page. */
async function setPassword(page: Page, password: string): Promise<void> {
  await formReady(page, 'nymbal-reset-password-form')
  const form = page.locator('nymbal-reset-password-form')
  await form.getByTestId('reset-password').fill(password)
  await form.getByTestId('reset-submit').click()
}

test.describe('Forgot password', () => {
  test('AC-24: from the sign-in page, Forgot password? asks for a link with the same answer for an unknown and a registered address; where mail is delivered, the link survives a scanner’s fetch, sets a password once and signs the shopper in, and only the new password signs in afterwards @capabilities', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000)
    const caps = await storeCapabilities(request)
    const delivering = isCustomProject(testInfo.project.name)
    expect(delivers(caps), JSON.stringify(caps)).toBe(delivering)
    const shopper = newShopper('reset-journey')
    // A confirmed account on every store: on a store that confirms sign-ups, the link from its mail is followed first.
    await registerVerified(shopper)

    await page.goto('/account/login')
    await page.getByTestId('forgot-password-link').click()
    await page.waitForURL(onPath(FORGOT_PATH), { timeout: 10_000 })
    const unknownText = await askForLink(page, `nobody-${randomUUID().slice(0, 8)}@e2e.test`)
    await page.goto(FORGOT_PATH)
    const registeredText = await askForLink(page, shopper.email)

    expect(registeredText).toBe(unknownText)
    if (!delivering) return

    const mail = await mailbox()
    // Registering mailed the confirmation link first: the address holds two mails, and the reset is the one linking to
    // its page.
    const mails = await mail.waitFor(shopper.email, 2)
    const resetMail = mails.find((m) => linksIn(m).some((url) => url.pathname === RESET_PATH))
    const link = linkTo(resetMail ?? mails[0]!, RESET_PATH)
    expect(link.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/)
    // The store mails one storefront's URL; the journey opens the link's path and fragment on this project's own.
    const here = `${link.pathname}${link.hash}`
    // A mail scanner fetches the link without running the page: the token is in the fragment, which it never sends.
    const scanned = await request.get(link.pathname)
    expect(scanned.status(), 'the scanner gets the page, not an error').toBeLessThan(400)

    const next = `New-${randomUUID().slice(0, 8)}-Password`
    const signedIn = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/customers/me' && res.status() === 200,
      { timeout: 15_000 },
    )
    await page.goto(here)
    await setPassword(page, next)
    await page.waitForURL(onAccountHome, { timeout: 15_000 })
    expect((await signedIn).status()).toBe(200)

    await page.goto(here)
    await setPassword(page, `Again-${randomUUID().slice(0, 8)}-Password`)
    await expect(page.getByTestId('reset-invalid')).toBeVisible({ timeout: 10_000 })

    expect([
      await apiSignInStatus(shopper.email, next),
      await apiSignInStatus(shopper.email, shopper.password),
    ]).toEqual([200, 401])
  })
})
