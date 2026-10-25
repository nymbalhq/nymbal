import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type { NymbalConfig } from '@nymbalhq/config'
import type { Kernel } from './kernel.js'
import type { RawReader } from './raw.js'
import { login, primedShopper } from './security.js'
import type { CookieJar, ShopResponse } from './shopper.js'

// What the recently-viewed suites share: the capture and read routes over HTTP, the views the event log holds, the
// visitor cookie as a response sets it, and bearer tokens that decode to no auth (expired, or signed with another
// secret). Nothing here knows how the routes, the service or the projection are built.

export const VISITOR_COOKIE = 'nymbal.visitor'
export const ROUTE = '/api/recently-viewed'
export const VIEWED = 'product.viewed.v1'
export const MERGED = 'visitor.merged.v1'
export const PASSWORD = 'correct-horse-battery'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The kernel config with the capture route's bound lifted, for suites that send many requests from one IP. */
export function liftedViewLimit(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    security: {
      ...config.security,
      rateLimit: {
        ...config.security.rateLimit,
        [ROUTE]: { requests: 100_000, window: '1m', action: 'block' },
      },
    },
  }
}

export type Shop = Awaited<ReturnType<typeof primedShopper>>

/** One `Set-Cookie` of a response, by name: its value and its attributes, names lowercased. */
export interface SetCookie {
  value: string
  attributes: Record<string, string | true>
}

export function setCookieOf(res: { setCookies: string[] }, name: string): SetCookie | undefined {
  for (const header of res.setCookies) {
    const [pair, ...attrs] = header.split(';').map((s) => s.trim())
    const at = pair!.indexOf('=')
    if (at < 0 || pair!.slice(0, at) !== name) continue
    const attributes: Record<string, string | true> = {}
    for (const attr of attrs) {
      const eq = attr.indexOf('=')
      if (eq < 0) attributes[attr.toLowerCase()] = true
      else attributes[attr.slice(0, eq).toLowerCase()] = attr.slice(eq + 1)
    }
    return { value: pair!.slice(at + 1), attributes }
  }
  return undefined
}

export interface LoggedView {
  seq: number
  timestamp: string
  productId: string
  viewer: { kind: string; id: string }
}

/** Every `product.viewed.v1` in the event log, in seq order, as a second connection reads it. */
export async function viewsInLog(raw: RawReader): Promise<LoggedView[]> {
  const rows = await raw.rows<{ seq: number | string; envelope: string | Record<string, unknown> }>(
    'SELECT seq, envelope FROM events WHERE type = ? ORDER BY seq',
    [VIEWED],
  )
  return rows.map((r) => {
    const envelope = (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope) as {
      timestamp: string
      payload: { productId: string; viewer: { kind: string; id: string } }
    }
    return {
      seq: Number(r.seq),
      timestamp: envelope.timestamp,
      productId: envelope.payload.productId,
      viewer: envelope.payload.viewer,
    }
  })
}

/** Every `visitor.merged.v1` payload in the event log, in seq order. */
export async function mergesInLog(
  raw: RawReader,
): Promise<Array<{ visitorId: string; customerId: string }>> {
  const rows = await raw.rows<{ envelope: string | Record<string, unknown> }>(
    'SELECT envelope FROM events WHERE type = ? ORDER BY seq',
    [MERGED],
  )
  return rows.map(
    (r) =>
      (
        (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope) as {
          payload: { visitorId: string; customerId: string }
        }
      ).payload,
  )
}

/** The reference list: of these views, each product once at its newest, newest first (ties by productId), 12 at most. */
export function expectedList(views: Array<{ productId: string; timestamp: string }>): string[] {
  const newest = new Map<string, string>()
  for (const v of views) {
    const held = newest.get(v.productId)
    if (held === undefined || v.timestamp > held) newest.set(v.productId, v.timestamp)
  }
  return [...newest]
    .sort(([pa, ta], [pb, tb]) => (ta === tb ? pa.localeCompare(pb) : tb.localeCompare(ta)))
    .slice(0, 12)
    .map(([productId]) => productId)
}

export interface Customer {
  id: string
  email: string
}

/** A customer of its own, registered through the auth service. */
export async function registeredCustomer(k: Kernel): Promise<Customer> {
  const email = `viewer-${randomUUID()}@recently-viewed.test`
  const { customer } = await k.services.auth.register({ email, password: PASSWORD })
  return { id: customer.id, email }
}

/** Logs `customer` in over HTTP from `shop`'s jar (which then holds the refresh cookie) and returns the bearer. */
export async function bearerOf(
  baseUrl: string,
  jar: CookieJar,
  customer: Customer,
): Promise<string> {
  const answer = await login(baseUrl, jar, { email: customer.email, password: PASSWORD })
  if (answer.status !== 200)
    throw new Error(`login: ${answer.status} ${JSON.stringify(answer.body)}`)
  const refresh = answer.headers
    .getSetCookie()
    .find((c) => c.startsWith('nymbal.refresh='))
    ?.split(';')[0]
  if (refresh !== undefined) jar.set('nymbal.refresh', refresh.slice('nymbal.refresh='.length))
  return answer.body.data!.accessToken
}

/** An access token for `customer` that verification refuses: past its 15 minutes, or signed with another secret. */
export async function lapsedToken(
  k: Kernel,
  customer: Customer,
  how: 'expired' | 'foreign',
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const secret =
    how === 'foreign' ? `another-secret-${randomUUID()}` : k.config.security.auth.jwtSecret
  const issuedAt = how === 'expired' ? now - 16 * 60 : now
  return new SignJWT({
    sub: customer.id,
    email: customer.email,
    roles: ['customer'],
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(issuedAt)
    .setIssuer('nymbal')
    .setExpirationTime(issuedAt + 15 * 60)
    .sign(new TextEncoder().encode(secret))
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

/** `POST /api/recently-viewed` from `shop`, with any extra headers. */
export function record(
  shop: Shop,
  productId: unknown,
  headers: Record<string, string> = {},
): Promise<ShopResponse<unknown>> {
  return shop.call('POST', ROUTE, productId === undefined ? {} : { productId }, { headers })
}

export interface ServedList {
  status: number
  ids: string[] | null
  body: ShopResponse<{ items: Array<{ id: string; slug: string; status?: string }> }>['body']
  cacheControl: string | null
  setCookies: string[]
}

/** `GET /api/recently-viewed` (with `query`, when given) from `shop`, with any extra headers. */
export async function list(
  shop: Shop,
  headers: Record<string, string> = {},
  query = '',
): Promise<ServedList> {
  const res = await shop.call<{ items: Array<{ id: string; slug: string }> }>(
    'GET',
    `${ROUTE}${query}`,
    undefined,
    { headers },
  )
  return {
    status: res.status,
    ids: res.body.data?.items.map((p) => p.id) ?? null,
    body: res.body,
    cacheControl: res.headers.get('cache-control'),
    setCookies: res.setCookies,
  }
}

/** A shopper of its own over HTTP: a CSRF-primed jar and nothing else. */
export function freshShop(baseUrl: string): Promise<Shop> {
  return primedShopper(baseUrl)
}

/** How many rows `table` holds, as a second connection reads it. */
export function rowsOf(raw: RawReader, table: string): Promise<number> {
  return raw.count(table)
}
