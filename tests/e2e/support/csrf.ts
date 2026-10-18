import type { APIRequestContext } from '@playwright/test'

// P1-06: the CSRF pair for a Playwright request context, the shape of packages/platform/tests/support/shopper.ts.
// `GET /api/csrf` sets the `nymbal.csrf` cookie in the context's jar (or returns the one it already holds) and answers
// the same token, which every POST/PUT/PATCH/DELETE then sends as `x-csrf-token`.

export const API_URL = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'
export const CSRF_HEADER = 'x-csrf-token'

/** Headers carrying the context's CSRF token; spread them into every unsafe request's `headers`. */
export async function csrf(
  request: APIRequestContext,
  apiUrl: string = API_URL,
): Promise<Record<string, string>> {
  const res = await request.get(`${apiUrl}/api/csrf`)
  if (!res.ok()) throw new Error(`GET /api/csrf answered ${res.status()}`)
  const body = (await res.json()) as { data?: { token?: string } }
  const token = body.data?.token
  if (typeof token !== 'string' || token === '') throw new Error('GET /api/csrf returned no token')
  return { [CSRF_HEADER]: token }
}
