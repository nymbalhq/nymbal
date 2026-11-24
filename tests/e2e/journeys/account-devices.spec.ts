import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'
import { API_URL, csrf } from '../support/csrf'
import { expect, test } from '../support/fixtures'
import { newShopper, registerThroughApi, requestsTo, type Shopper } from '../support/passwords'
import { signIn } from '../support/sign-in'

// The devices section of the profile page, on both storefronts. The shopper signs in in two browsers through the
// storefront's sign-in page, the second with an iPhone's user agent; the first lists both devices on its profile and
// signs the other out, or signs out everywhere. A browser whose session ended is refused at its next page load's
// refresh and lands on the sign-in page. It reads no mail, so it runs on the native stores.

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'

const onPath = (path: string) => (url: URL) => url.pathname.replace(/\/$/, '') === path
const onAccountHome = onPath('/account')
const onLogin = onPath('/account/login')
const pathOf = (href: string): string => new URL(href).pathname

interface Listed {
  id: string
  device: string
  current: boolean
}

/** The shopper signed in in this page and in a second browser of its own with an iPhone's user agent. */
async function signedInTwice(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
  shopper: Shopper,
): Promise<{ other: BrowserContext; second: Page }> {
  const baseURL = testInfo.project.use.baseURL
  if (baseURL === undefined) throw new Error(`project ${testInfo.project.name} has no baseURL`)
  const other = await browser.newContext({ baseURL, userAgent: IPHONE })
  const second = await other.newPage()
  await signIn(page, shopper.email, shopper.password)
  await page.waitForURL(onAccountHome, { timeout: 15_000 })
  await signIn(second, shopper.email, shopper.password)
  await second.waitForURL(onAccountHome, { timeout: 15_000 })
  return { other, second }
}

/** Opens the profile page and answers the sessions its list read, once the list shows them. */
async function openDevices(page: Page): Promise<Listed[]> {
  const listed = page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === '/api/customers/me/sessions' &&
      res.status() === 200,
    { timeout: 15_000 },
  )
  await page.goto('/account/profile')
  const body = (await (await listed).json()) as { data?: { sessions?: Listed[] } }
  const sessions = body.data?.sessions ?? []
  await expect(page.locator('nymbal-session-list').getByTestId('session-row')).toHaveCount(
    sessions.length,
    { timeout: 10_000 },
  )
  return sessions
}

/** The row of the session that is not this browser's. */
function otherRow(page: Page) {
  return page
    .locator('nymbal-session-list')
    .getByTestId('session-row')
    .filter({ hasNot: page.getByTestId('session-current') })
}

/** The status the API answers this browser's refresh cookie with, and then `GET /api/customers/me` with no bearer. */
async function sessionStatuses(context: BrowserContext): Promise<number[]> {
  const refresh = await context.request.post(`${API_URL}/api/auth/refresh`, {
    headers: await csrf(context.request),
  })
  const me = await context.request.get(`${API_URL}/api/customers/me`)
  return [refresh.status(), me.status()]
}

test.describe('Signed-in devices', () => {
  test('AC-15: the profile lists both browsers with this one marked; signing the other out leaves one row, lands the other on the sign-in page at its next load, and keeps this one signed in', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const shopper = newShopper('devices-one')
    await registerThroughApi(shopper)
    const { other, second } = await signedInTwice(page, browser, testInfo, shopper)
    try {
      const sessions = await openDevices(page)
      const list = page.locator('nymbal-session-list')

      expect(sessions.map((s) => s.current).sort()).toEqual([false, true])
      await expect(list.getByTestId('session-current')).toHaveCount(1)
      for (const row of await list.getByTestId('session-row').all()) {
        await expect(row.getByTestId('session-device')).toHaveText(/\S/)
        await expect(row.locator('time[datetime]')).toHaveCount(2)
      }
      await expect(otherRow(page).getByTestId('session-device')).toHaveText('Safari on iPhone')

      await otherRow(page).getByTestId('session-end').click()
      await expect(list.getByTestId('session-row')).toHaveCount(1)
      await expect(list.getByTestId('sessions-error')).toHaveCount(0)

      await second.goto('/account')
      await second.waitForURL(onLogin, { timeout: 15_000 })

      const profile = pathOf(page.url())
      const me = page.waitForResponse(
        (res) => new URL(res.url()).pathname === '/api/customers/me' && res.status() === 200,
        { timeout: 15_000 },
      )
      await page.reload()
      const answered = (await (await me).json()) as { data?: { email?: string } }
      expect(answered.data?.email).toBe(shopper.email)
      expect(pathOf(page.url()), 'the first browser is still on its profile').toBe(profile)
    } finally {
      await other.close()
    }
  })

  test('AC-16: Sign out everywhere lands this browser on the sign-in page with no session left, and the other browser on the sign-in page at its next load', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const shopper = newShopper('devices-all')
    await registerThroughApi(shopper)
    const { other, second } = await signedInTwice(page, browser, testInfo, shopper)
    try {
      await openDevices(page)

      await page.locator('nymbal-session-list').getByTestId('sessions-end-all').click()
      await page.waitForURL(onLogin, { timeout: 15_000 })

      expect(await sessionStatuses(page.context()), 'refresh, then /api/customers/me').toEqual([
        401, 401,
      ])
      await second.goto('/account')
      await second.waitForURL(onLogin, { timeout: 15_000 })
    } finally {
      await other.close()
    }
  })

  test('AC-17: a double click on the other device’s Sign out sends one DELETE of that session and removes its row with no error; a double click on Sign out everywhere sends one DELETE of every session', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(90_000)
    const shopper = newShopper('devices-once')
    await registerThroughApi(shopper)
    const { other } = await signedInTwice(page, browser, testInfo, shopper)
    try {
      const sessions = await openDevices(page)
      const theirs = sessions.find((s) => !s.current)
      const list = page.locator('nymbal-session-list')

      const one = requestsTo(page, 'DELETE', `/api/customers/me/sessions/${theirs?.id}`)
      try {
        await otherRow(page).getByTestId('session-end').dblclick()
        await expect(list.getByTestId('session-row')).toHaveCount(1)
        await page.waitForLoadState('networkidle')
        expect(one.count(), 'DELETEs of the other session for two clicks').toBe(1)
      } finally {
        one.stop()
      }
      await expect(list.getByTestId('sessions-error')).toHaveCount(0)

      const all = requestsTo(page, 'DELETE', '/api/customers/me/sessions')
      try {
        await list.getByTestId('sessions-end-all').dblclick()
        await page.waitForURL(onLogin, { timeout: 15_000 })
        await page.waitForLoadState('networkidle')
        expect(all.count(), 'DELETEs of every session for two clicks').toBe(1)
      } finally {
        all.stop()
      }
    } finally {
      await other.close()
    }
  })
})
