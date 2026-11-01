import type { RawReader } from './raw.js'
import { shopper, type CookieJar } from './shopper.js'

// A shopper holding a CSRF cookie, logins over HTTP, and the roles a token and a row carry.

export const CSRF_COOKIE = 'nymbal.csrf'
export const CSRF_HEADER = 'x-csrf-token'

/**
 * A shopper whose jar holds the `nymbal.csrf` cookie. Only `GET /api/csrf` sets it, as a browser client fetches it;
 * the shopper then echoes it in `x-csrf-token` on every request.
 */
export async function primedShopper(baseUrl: string, jar: CookieJar = new Map()) {
  const shop = shopper(baseUrl, jar)
  const primed = await shop.call('GET', '/api/csrf')
  if (!jar.has(CSRF_COOKIE)) {
    throw new Error(`GET /api/csrf (${primed.status}) set no ${CSRF_COOKIE} cookie`)
  }
  return shop
}

export interface LoginAnswer {
  status: number
  headers: Headers
  body: {
    data?: { accessToken: string; customer: { id: string; email: string } }
    error?: { code: string; message: string; retryAfter?: number }
  }
}

/** One `POST /api/auth/login` carrying the jar's CSRF pair and any extra headers (`x-forwarded-for`). */
export async function login(
  baseUrl: string,
  jar: CookieJar,
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
): Promise<LoginAnswer> {
  const csrf = jar.get(CSRF_COOKIE)
  const res = await fetch(new URL('/api/auth/login', baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      ...(csrf !== undefined && { [CSRF_HEADER]: csrf }),
      ...headers,
    },
    body: JSON.stringify(credentials),
  })
  const text = await res.text()
  return {
    status: res.status,
    headers: res.headers,
    body: text === '' ? {} : (JSON.parse(text) as LoginAnswer['body']),
  }
}

/** The `roles` claim of an access token, read without verifying it. */
export function tokenRoles(accessToken: string): string[] {
  const [, payload] = accessToken.split('.')
  if (payload === undefined) throw new Error('not a JWT')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    roles?: unknown
  }
  if (!Array.isArray(claims.roles)) throw new Error('token has no roles array')
  return claims.roles as string[]
}

/** `customers.roles` as stored: a JSON text array in SQLite, jsonb in Postgres. */
export async function rolesColumn(raw: RawReader, customerId: string): Promise<string[]> {
  const row = await raw.one<{ roles: string | string[] }>(
    'SELECT roles FROM customers WHERE id = ?',
    [customerId],
  )
  return typeof row.roles === 'string' ? (JSON.parse(row.roles) as string[]) : row.roles
}

/** `customers.metadata` as stored. */
export async function metadataColumn(
  raw: RawReader,
  customerId: string,
): Promise<Record<string, unknown>> {
  const row = await raw.one<{ metadata: string | Record<string, unknown> }>(
    'SELECT metadata FROM customers WHERE id = ?',
    [customerId],
  )
  return typeof row.metadata === 'string'
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : row.metadata
}
