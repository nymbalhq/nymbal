import type { Page, Request } from '@playwright/test'

/** The access token with its expiry put an hour in the past: a token the API refuses as it refuses a lapsed one. */
function lapsedJwt(token: string): string {
  const [header, payload, signature] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { exp: number }
  claims.exp = Math.floor(Date.now() / 1000) - 3600
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
}

export interface Lapse {
  /** The status the API answered the request sent with the lapsed token, or null until it has answered. */
  status(): number | null
}

/**
 * The page's next `method` request to `path` that carries a bearer goes with that token lapsed, once, and the API
 * answers it as it answers any lapsed token (it is not stubbed). The shopper's token lives in the page's memory, so
 * the lapse is made on the wire; what the page does with the API's 401 is what the test then sees. Name a route that
 * refuses a lapsed bearer (checkout, recently viewed, the customer's own reads): one that reads it as a guest's
 * answers no 401. Call before the request is sent.
 */
export async function lapseNextBearer(page: Page, method: string, path: string): Promise<Lapse> {
  let sent: Request | null = null
  let answered: number | null = null
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      const request = route.request()
      const bearer = /^Bearer (.+)$/i.exec((await request.headerValue('authorization')) ?? '')
      if (sent !== null || request.method() !== method || bearer === null) {
        await route.fallback()
        return
      }
      sent = request
      const headers = {
        ...(await request.allHeaders()),
        authorization: `Bearer ${lapsedJwt(bearer[1]!)}`,
      }
      await route.continue({ headers })
      void request.response().then((res) => {
        answered = res?.status() ?? null
      })
    },
  )
  return { status: () => answered }
}
