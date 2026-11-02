import type { Page } from '@playwright/test'

/** Where the storefronts' SDK client keeps the shopper's access token (`tokenStorage: 'localStorage'`). */
export const TOKEN_KEY = 'nymbal.auth.accessToken'

/**
 * The stored access token, its expiry put an hour in the past: a token the API refuses as it refuses a lapsed one. The
 * page must be on the storefront's origin with a signed-in shopper.
 */
export async function lapseStoredToken(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const token = localStorage.getItem(key)
    if (token === null) throw new Error('no access token is stored: is the shopper signed in?')
    const [header, payload, signature] = token.split('.')
    const claims = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp: number
    }
    claims.exp = Math.floor(Date.now() / 1000) - 3600
    const lapsed = btoa(JSON.stringify(claims))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    localStorage.setItem(key, `${header}.${lapsed}.${signature}`)
  }, TOKEN_KEY)
}
