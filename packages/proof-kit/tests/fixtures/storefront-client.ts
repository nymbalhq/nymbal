// A shopper over HTTP. Keeps the cookies the store sets (cart, CSRF) and echoes the CSRF cookie in the header the
// security middleware checks, as the storefront SDK does: before an unsafe call with no CSRF cookie it fetches
// `GET /api/csrf`, the one answer that sets it.

const CSRF_COOKIE = 'nymbal.csrf'
const CSRF_HEADER = 'x-csrf-token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface StorefrontResponse<T> {
  status: number
  body: { data?: T; error?: { code: string; message: string } }
}

export function storefrontClient(baseUrl: string) {
  const jar = new Map<string, string>()

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<StorefrontResponse<T>> {
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
    Object.assign(headers, extraHeaders)
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const at = pair!.indexOf('=')
      if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim())
    }
    const text = await res.text()
    return { status: res.status, body: text === '' ? {} : JSON.parse(text) }
  }

  return { call }
}
