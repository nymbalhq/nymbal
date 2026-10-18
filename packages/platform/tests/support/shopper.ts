// A shopper over HTTP (the shape of packages/proof-kit/tests/fixtures/storefront-client.ts): keeps the cookies the
// store sets (cart, CSRF) and echoes the CSRF cookie in the header the security middleware checks.

const CSRF_COOKIE = 'nymbal.csrf'
const CSRF_HEADER = 'x-csrf-token'

export interface ShopResponse<T> {
  status: number
  body: { data?: T; error?: { code: string; message: string } }
}

export function shopper(baseUrl: string) {
  const jar = new Map<string, string>()

  async function call<T>(method: string, path: string, body?: unknown): Promise<ShopResponse<T>> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (jar.size > 0) {
      headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    const csrf = jar.get(CSRF_COOKIE)
    if (csrf !== undefined) headers[CSRF_HEADER] = csrf
    if (body !== undefined) headers['content-type'] = 'application/json'
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
