import type { Page } from '@playwright/test'

/**
 * Resolves once the page's `tag` element is defined and has no update pending. A storefront form is server-rendered,
 * so its fields take input before the element upgrades (on Next, in a React effect after `load`), and the upgrade's
 * first render empties a field filled before it.
 */
export async function formReady(page: Page, tag: string): Promise<void> {
  await page.locator(tag).evaluate(async (el) => {
    await customElements.whenDefined(el.localName)
    const host = el as unknown as { updateComplete: Promise<boolean> }
    // `false`: another update was requested during the last one, so wait for that one too.
    while (!(await host.updateComplete));
  })
}

/** Opens the storefront's sign-in page and submits its form (`submitSignInForm`); the caller asserts what follows. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
  path = '/account/login',
): Promise<void> {
  await page.goto(path)
  await submitSignInForm(page, email, password)
}

/** Fills the open page's `nymbal-login-form` once it is ready (`formReady`) and submits it. */
export async function submitSignInForm(page: Page, email: string, password: string): Promise<void> {
  await formReady(page, 'nymbal-login-form')
  const form = page.locator('nymbal-login-form')
  await form.getByTestId('login-email').fill(email)
  await form.getByTestId('login-password').fill(password)
  await form.getByTestId('login-submit').click()
}
