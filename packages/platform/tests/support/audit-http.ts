import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Kernel } from './kernel.js'
import { shopper, type ShopResponse } from './shopper.js'

// P3-04 support (spec P3-04-audit-trail), the HTTP half: an admin and a customer over HTTP who can send any header, and
// the activity API's pages (decision 7). Kept apart from the table reads (audit.ts) so the CLI's tests, compiled with
// the root project, can use it without the second-connection reader. Nothing here knows how the audit scope, the
// idempotency wrapper or the repository are implemented.

export const IDEMPOTENCY_KEY = 'Idempotency-Key'
export const REPLAYED = 'idempotent-replayed'
export const CORRELATION = 'x-correlation-id'
/** Decision 5's well-formed key. */
export const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/** A shopper whose jar holds the CSRF cookie: one safe request makes the guard mint it. */
async function primed(baseUrl: string) {
  const shop = shopper(baseUrl)
  const res = await shop.call('GET', '/health')
  if (!shop.jar.has('nymbal.csrf'))
    throw new Error(`GET /health (${res.status}) set no CSRF cookie`)
  return shop
}

export interface Answer<T = unknown> {
  status: number
  body: { data?: T; meta?: Record<string, unknown>; error?: { code: string; message: string } }
  headers: Headers
  correlationId: string | null
  /** The response's `Idempotent-Replayed`, or null when it has none. */
  replayed: string | null
}

function answerOf<T>(res: ShopResponse<T>): Answer<T> {
  return {
    status: res.status,
    body: res.body as Answer<T>['body'],
    headers: res.headers,
    correlationId: res.headers.get(CORRELATION),
    replayed: res.headers.get(REPLAYED),
  }
}

export interface AdminSession {
  userId: string
  email: string
  send<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Answer<T>>
}

/** An admin account of its own (roles ['admin'], a known id), signed in over HTTP; every call carries its token. */
export async function adminSession(k: Kernel, baseUrl: string): Promise<AdminSession> {
  const userId = randomUUID()
  const email = `admin-${userId}@p3-04.test`
  const password = 'correct-horse-battery'
  const now = new Date()
  await k.store.transaction((tx) =>
    k.repos.customer.insert(tx, {
      id: userId,
      email,
      passwordHash: bcrypt.hashSync(password, 4),
      roles: ['admin'],
      requiresPasswordReset: false,
      createdAt: now,
      updatedAt: now,
    }),
  )
  const shop = await primed(baseUrl)
  const answer = await shop.call<{ accessToken: string }>('POST', '/api/auth/login', {
    email,
    password,
  })
  if (answer.status !== 200) throw new Error(`admin login: ${JSON.stringify(answer.body)}`)
  const token = answer.body.data!.accessToken
  return {
    userId,
    email,
    async send(method, path, body, headers = {}) {
      return answerOf(
        await shop.call(method, path, body, {
          headers: { authorization: `Bearer ${token}`, ...headers },
        }),
      )
    },
  }
}

/** A shopper signed in as a customer of its own, registered over HTTP. */
export async function customerSession(baseUrl: string) {
  const shop = await primed(baseUrl)
  const email = `customer-${randomUUID()}@p3-04.test`
  const password = 'p3-04-correct-horse'
  const registered = await shop.call<{ customer: { id: string }; accessToken: string }>(
    'POST',
    '/api/auth/register',
    { email, password },
  )
  if (registered.status !== 201) throw new Error(`register: ${JSON.stringify(registered.body)}`)
  const token = registered.body.data!.accessToken
  return {
    customerId: registered.body.data!.customer.id,
    email,
    jar: shop.jar,
    async send<T = unknown>(
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<Answer<T>> {
      return answerOf(
        await shop.call<T>(method, path, body, {
          headers: { authorization: `Bearer ${token}`, ...headers },
        }),
      )
    },
  }
}

/** Every entry `GET /api/admin/activity` lists for `query`, following `meta.nextCursor` to the last page. */
export async function activityEntries(
  admin: AdminSession,
  query: Record<string, string> = {},
): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({ ...query, ...(cursor !== undefined && { cursor }) })
    const res = await admin.send<Array<Record<string, unknown>>>(
      'GET',
      `/api/admin/activity?${params.toString()}`,
    )
    if (res.status !== 200) {
      throw new Error(`GET /api/admin/activity: ${res.status} ${JSON.stringify(res.body)}`)
    }
    entries.push(...(res.body.data ?? []))
    const next = res.body.meta?.['nextCursor']
    if (typeof next !== 'string' || next === '') return entries
    cursor = next
  }
  throw new Error('GET /api/admin/activity: more than 1000 pages')
}
