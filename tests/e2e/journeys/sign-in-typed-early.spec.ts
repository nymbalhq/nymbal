import { randomUUID } from 'node:crypto'
import { expect, test } from '../support/fixtures'
import { API_URL, csrf } from '../support/csrf'
import { formReady } from '../support/sign-in'

// A shopper on a slow connection types into the server-rendered sign-in form before its element is defined. What they
// typed is still in the fields once the element upgrades and renders, and signs them in. The element's definition is
// held back until the shopper has typed, so the upgrade always comes after the typing. Both template projects run
// this file.

const HELD_TAG = 'nymbal-login-form'

declare global {
  interface Window {
    /** Whether the page has tried to define the held element. */
    __heldDefinitionRequested?: () => boolean
    /** Defines the held element, as the page asked to. */
    __releaseHeldDefinition?: () => void
  }
}

test('AC-4: an email and password typed into the server-rendered sign-in form before its element is defined are still there after it upgrades, and sign the shopper in', async ({
  page,
  request,
}) => {
  const email = `typed-early-${randomUUID().slice(0, 8)}@e2e.test`
  const password = `Typed-${randomUUID().slice(0, 8)}!`
  const registered = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password, firstName: 'Ada', lastName: 'Early' },
  })
  expect(registered.ok(), `POST /api/auth/register: ${await registered.text()}`).toBe(true)

  // The page's first definition of the tag is held until the test releases it; a repeated one is ignored.
  await page.addInitScript((tag: string) => {
    const registry = window.customElements
    const define = registry.define.bind(registry)
    let held: Parameters<CustomElementRegistry['define']> | null = null
    registry.define = (name, constructor, options) => {
      if (name !== tag) return define(name, constructor, options)
      held ??= [name, constructor, options]
    }
    window.__heldDefinitionRequested = () => held !== null
    window.__releaseHeldDefinition = () => {
      if (held !== null && registry.get(tag) === undefined) define(...held)
    }
  }, HELD_TAG)

  await page.goto('/account/login')
  await page.waitForFunction(() => window.__heldDefinitionRequested?.() === true)
  expect(
    await page.evaluate((tag) => customElements.get(tag) === undefined, HELD_TAG),
    'the form is not defined while the shopper types',
  ).toBe(true)

  const form = page.locator(HELD_TAG)
  const emailField = form.getByTestId('login-email')
  const passwordField = form.getByTestId('login-password')
  await emailField.fill(email)
  await passwordField.fill(password)

  await page.evaluate(() => window.__releaseHeldDefinition?.())
  await formReady(page, HELD_TAG)

  await expect(emailField).toHaveValue(email)
  await expect(passwordField).toHaveValue(password)

  await form.getByTestId('login-submit').click()
  await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/account', {
    timeout: 15_000,
  })

  // Signed in: the account page, loaded afresh, reads the shopper's profile and keeps them on it.
  const me = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/customers/me',
  )
  await page.reload()
  const profile = await me
  expect(profile.status(), 'GET /api/customers/me after the sign-in').toBe(200)
  // The page's session, read over the API with the bearer the page sent, is the account the typed credentials name.
  const bearer = { authorization: (await profile.request().headerValue('authorization')) ?? '' }
  const signedIn = await request.get(`${API_URL}/api/customers/me`, { headers: bearer })
  expect(
    ((await signedIn.json()) as { data: { id: string } }).data.id,
    'the account signed in is the one registered with the typed email and password',
  ).toBe(((await registered.json()) as { data: { customer: { id: string } } }).data.customer.id)
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/account')
})
