import type { BrowserContext, Page } from '@playwright/test'

// The shopper's session as the browser holds it: the access tokens this browser's pages hold, read off the wire (the
// bearer each page sends the API, and the token in each sign-in, register and refresh answer whose body is still
// there to read; a body is gone once its page navigates away), and what of them the storefront's Web Storage holds.

const ISSUING = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/refresh'])

export interface IssuedTokens {
  /** Every access token seen on any page of the context so far, each once. */
  all(): Promise<string[]>
}

/** Records every access token the context's pages send or are answered from now on. */
export function watchAccessTokens(context: BrowserContext): IssuedTokens {
  const pending: Array<Promise<string | null>> = []
  context.on('request', (req) => {
    if (!new URL(req.url()).pathname.startsWith('/api/')) return
    // The headers as the page sent them, read now: headerValue() waits for the raw headers, which never come for a
    // request a navigation cancels (a reload during the session's refresh), and would hold all() forever.
    const value = req.headers()['authorization']
    pending.push(Promise.resolve(/^Bearer (.+)$/i.exec(value ?? '')?.[1] ?? null))
  })
  context.on('response', (res) => {
    if (res.request().method() !== 'POST' || !res.ok()) return
    if (!ISSUING.has(new URL(res.url()).pathname)) return
    pending.push(
      res
        .json()
        .then((body: { data?: { accessToken?: string } }) => body.data?.accessToken ?? null)
        .catch(() => null),
    )
  })
  return {
    all: async () => [
      ...new Set(
        (await Promise.all(pending)).filter((t): t is string => typeof t === 'string' && t !== ''),
      ),
    ],
  }
}

/** Every key and value in the page's localStorage and sessionStorage that contains one of `tokens`. */
export async function storageHolding(page: Page, tokens: string[]): Promise<string[]> {
  const entries = await page.evaluate(() => {
    const out: string[] = []
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!
        out.push(key, storage.getItem(key) ?? '')
      }
    }
    return out
  })
  return entries.filter((entry) => tokens.some((token) => entry.includes(token)))
}
