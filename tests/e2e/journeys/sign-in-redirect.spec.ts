import { randomUUID } from 'node:crypto'
import { expect, test } from '../support/fixtures'
import { API_URL, csrf } from '../support/csrf'
import { submitSignInForm } from '../support/sign-in'

// A sign-in link whose `?redirect` names another origin does not take the shopper off the store: signing in lands on
// the store's own /account and the page never leaves the store's origin. Both template projects run this file. The
// same-origin case (`?redirect=%2Faccount%2Fprofile` → /account/profile) is account-signed-in.spec.ts's AC-5.

const ELSEWHERE = 'https://evil.example'

test('AC-12: signing in on /account/login?redirect=https%3A%2F%2Fevil.example%2F lands on the store’s own /account, and the page never leaves the store’s origin', async ({
  page,
  request,
  baseURL,
}) => {
  const email = `redirect-${randomUUID().slice(0, 8)}@e2e.test`
  const password = 'TestPassword123!'
  const registered = await request.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(request),
    data: { email, password, firstName: 'Ada', lastName: 'Redirect' },
  })
  expect(registered.ok(), `POST /api/auth/register: ${await registered.text()}`).toBe(true)

  // Were the template to follow the link, the other origin answers a page of its own rather than a network error.
  await page.route(`${ELSEWHERE}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>elsewhere</h1>' }),
  )
  const origins: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) origins.push(new URL(frame.url()).origin)
  })

  await page.goto(`/account/login?redirect=${encodeURIComponent(`${ELSEWHERE}/`)}`)
  const store = new URL(baseURL!).origin
  await submitSignInForm(page, email, password)
  await page.waitForURL(
    (url) => url.origin !== store || url.pathname.replace(/\/$/, '') === '/account',
    { timeout: 15_000 },
  )

  const landed = new URL(page.url())
  // The store's origin is the storefront the project serves, the origin the login page itself was on.
  expect(landed.origin).toBe(URL.parse(baseURL!)?.origin)
  expect(landed.pathname.replace(/\/$/, '')).toBe('/account')
  expect(origins.filter((origin) => origin !== store)).toEqual([])
})
