// A shopper over HTTP (the shape of packages/proof-kit/tests/fixtures/storefront-client.ts): keeps the cookies the
// store sets (cart, CSRF) and echoes the CSRF cookie in the header the security middleware checks. Before an unsafe
// call with no CSRF cookie in the jar it fetches `GET /api/csrf`, the one answer that sets it, as the SDK does. A jar
// passed in is shared, so two shoppers on two base URLs are one browser talking to two replicas.

const CSRF_COOKIE = 'nymbal.csrf'
const CSRF_HEADER = 'x-csrf-token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export type CookieJar = Map<string, string>

export interface ShopResponse<T> {
  status: number
  body: { data?: T; error?: { code: string; message: string } }
  /** Every `Set-Cookie` header of this response, verbatim. */
  setCookies: string[]
  headers: Headers
}

export function shopper(baseUrl: string, jar: CookieJar = new Map()) {
  /** `opts.headers` is applied last, so a test can tamper with the CSRF header or add `authorization`. */
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string> } = {},
  ): Promise<ShopResponse<T>> {
    if (!SAFE_METHODS.has(method.toUpperCase()) && !jar.has(CSRF_COOKIE)) {
      await call('GET', '/api/csrf')
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    if (jar.size > 0) {
      headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    const csrf = jar.get(CSRF_COOKIE)
    if (csrf !== undefined) headers[CSRF_HEADER] = csrf
    if (body !== undefined) headers['content-type'] = 'application/json'
    Object.assign(headers, opts.headers)
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookies = res.headers.getSetCookie()
    for (const cookie of setCookies) {
      const [pair] = cookie.split(';')
      const at = pair!.indexOf('=')
      if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim())
    }
    const text = await res.text()
    return {
      status: res.status,
      body: text === '' ? {} : JSON.parse(text),
      setCookies,
      headers: res.headers,
    }
  }

  return { call, jar }
}
