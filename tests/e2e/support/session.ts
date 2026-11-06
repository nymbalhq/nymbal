import type { BrowserContext, Page } from '@playwright/test'

// The shopper's session as the browser holds it: the access tokens this browser's pages hold, read off the wire (the
// bearer each page sends the API, and the token in each sign-in, register and refresh answer whose body is still
// readable once it is in), and what of them the storefront's Web Storage holds.

const ISSUING = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/refresh'])

/** How long all() waits for the answers it is still reading; each is read once its body is in, so this is slack. */
const READ_BOUND_MS = 10_000

export interface IssuedTokens {
  /** Every access token seen on any page of the context so far, each once. */
  all(): Promise<string[]>
}

/** Records every access token the context's pages send or are answered from now on. */
export function watchAccessTokens(context: BrowserContext): IssuedTokens {
  const tokens: Array<string | null> = []
  const reading = new Map<Promise<void>, string>()
  context.on('request', (req) => {
    if (!new URL(req.url()).pathname.startsWith('/api/')) return
    // The headers as the page sent them, read now: headerValue() waits for the raw headers, which never come for a
    // request a navigation cancels (a reload during the session's refresh).
    tokens.push(/^Bearer (.+)$/i.exec(req.headers()['authorization'] ?? '')?.[1] ?? null)
  })
  // An answer is read once its body is in. Read on `response` (headers in), the body of an answer a reload cut
  // mid-body never settles until the page closes, and all() with it; such a body never reached the page either.
  context.on('requestfinished', (req) => {
    if (req.method() !== 'POST' || !ISSUING.has(new URL(req.url()).pathname)) return
    const read = req
      .response()
      .then(async (res) =>
        res?.ok() ? ((await res.json()) as { data?: { accessToken?: string } }) : null,
      )
      .then((body) => {
        tokens.push(body?.data?.accessToken ?? null)
      })
      .catch(() => {})
      .finally(() => reading.delete(read))
    reading.set(read, `POST ${new URL(req.url()).pathname}`)
  })
  return {
    all: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `watchAccessTokens: ${reading.size} answer bodies still unread after ${READ_BOUND_MS} ms: ${[...reading.values()].join(', ')}`,
            ),
          )
        }, READ_BOUND_MS)
      })
      try {
        await Promise.race([Promise.all(reading.keys()), bound])
      } finally {
        clearTimeout(timer)
      }
      return [...new Set(tokens.filter((t): t is string => typeof t === 'string' && t !== ''))]
    },
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
