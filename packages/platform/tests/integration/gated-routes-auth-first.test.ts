import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { ZodTypeAny } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Role } from '@nymbalhq/types'
import { routeSchemas } from '../../src/routes/schemas.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { CSRF_COOKIE, CSRF_HEADER, login, primedShopper } from '../support/security.js'
import { unaudited } from '../support/write-audit.js'

// A gated route answers a caller who fails its gate from the gate alone: 401 with no bearer, 403 with the wrong role,
// whatever the params, query, body and Idempotency-Key say, so nobody outside learns the shape of the input it
// expects. Validation still runs behind the gate. Every `/api/admin/*` route in routeSchemas is behind
// requireRole('admin') but the event stream (gated by its ticket); the requireAuth routes are listed by hand.

const STREAM_ROUTE = 'GET /api/admin/events'
const REQUIRE_AUTH_ROUTES = [
  'GET /api/customers/me',
  'PATCH /api/customers/me',
  'GET /api/customers/me/addresses',
  'POST /api/customers/me/addresses',
  'DELETE /api/customers/me/addresses/:id',
  'GET /api/orders',
] as const

const ADMIN_ROUTES = Object.keys(routeSchemas).filter(
  (key) => key.split(' ')[1]!.startsWith('/api/admin/') && key !== STREAM_ROUTE,
)
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])
const MALFORMED_KEY = 'not a key!'

/** The first candidate the part's schema refuses, or undefined when it accepts all of them. */
function refused<T>(schema: ZodTypeAny | undefined, candidates: T[]): T | undefined {
  if (schema === undefined) return undefined
  return candidates.find((c) => !schema.safeParse(c).success)
}

interface Probe {
  route: string
  method: string
  url: string
  body: unknown
  /** The parts of the input that fail the route's schema. */
  failing: string[]
}

/**
 * A request every declared part of which the schema refuses, where HTTP can carry a refused value: a path parameter
 * as an empty segment, a query value as a string or repeated key, a body as JSON.
 */
function probeOf(route: string): Probe {
  const [method, path] = route.split(' ') as [string, string]
  const schema = routeSchemas[route]!
  const failing: string[] = []

  const names = [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!)
  const emptyParams = Object.fromEntries(names.map((name) => [name, '']))
  const paramsFail = refused(schema.params, [emptyParams]) !== undefined
  if (paramsFail) failing.push('params')
  const filled = path.replace(/:([A-Za-z]+)/g, () => (paramsFail ? '' : `probe-${randomUUID()}`))

  const shape = (schema.query as { shape?: Record<string, unknown> } | undefined)?.shape ?? {}
  const queryValues: Array<[string, string | string[]]> = []
  for (const key of Object.keys(shape)) {
    const bad = refused(
      schema.query,
      ['', 'x', '-1', ['a', 'b']].map((value) => ({ [key]: value })),
    )
    if (bad !== undefined) queryValues.push([key, bad[key]!])
  }
  if (queryValues.length > 0) failing.push('query')
  const search = new URLSearchParams()
  for (const [key, value] of queryValues) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v)
  }

  const body = refused(schema.body, [[], 'not-an-object', 42, null, {}])
  if (body !== undefined) failing.push('body')

  const query = search.toString()
  return {
    route,
    method,
    url: query === '' ? filled : `${filled}?${query}`,
    body,
    failing,
  }
}

interface Answer {
  route: string
  status: number
  code: string | undefined
  hasIssues: boolean
}

/** One line per answer, for a failure message. */
const listed = (answers: Answer[]): string =>
  answers
    .map((a) => `${a.route} ${a.status} ${a.code ?? '-'}${a.hasIssues ? ' +issues' : ''}`)
    .join('; ')

describe('a gated route’s gate answers before its input is read', () => {
  let k: Kernel
  let served: ServedKernel
  let csrf: { cookie: string; token: string }
  let customerToken: string
  let adminToken: string

  async function bearer(roles: Role[]): Promise<string> {
    const email = `gated-${randomUUID()}@gated.test`
    const password = 'correct-horse-battery'
    const now = new Date()
    await unaudited(() =>
      k.store.transaction((tx) =>
        k.repos.customer.insert(tx, {
          id: randomUUID(),
          email,
          passwordHash: bcrypt.hashSync(password, 4),
          roles,
          requiresPasswordReset: false,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    )
    const shop = await primedShopper(served.baseUrl)
    const answer = await login(served.baseUrl, shop.jar, { email, password })
    if (answer.status !== 200) throw new Error(`login: ${JSON.stringify(answer.body)}`)
    return answer.body.data!.accessToken
  }

  /** The probe with a valid CSRF pair, a malformed Idempotency-Key on a write, and `token` as the bearer if any. */
  async function send(probe: Probe, token?: string): Promise<Answer> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      cookie: `${CSRF_COOKIE}=${csrf.cookie}`,
      [CSRF_HEADER]: csrf.token,
    }
    if (!SAFE.has(probe.method)) headers['idempotency-key'] = MALFORMED_KEY
    if (probe.body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const res = await fetch(new URL(probe.url, served.baseUrl), {
      method: probe.method,
      headers,
      ...(probe.body !== undefined && { body: JSON.stringify(probe.body) }),
    })
    const text = await res.text()
    const body = (text === '' ? {} : JSON.parse(text)) as {
      error?: { code?: string; issues?: unknown; details?: unknown }
    }
    return {
      route: probe.route,
      status: res.status,
      code: body.error?.code,
      hasIssues: text.includes('"issues"'),
    }
  }

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    const shop = await primedShopper(served.baseUrl)
    const token = shop.jar.get(CSRF_COOKIE)!
    csrf = { cookie: token, token }
    customerToken = await bearer(['customer'])
    adminToken = await bearer(['admin'])
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-5: property over every /api/admin/* and requireAuth route: with a valid CSRF pair, no bearer and input that fails the schema (a malformed Idempotency-Key on writes), the answer is 401 auth.unauthorized with no issues', async () => {
    const routes = [...ADMIN_ROUTES, ...REQUIRE_AUTH_ROUTES]
    const answers: Answer[] = []
    for (const route of routes) answers.push(await send(probeOf(route)))
    const unauthorized = answers.filter(
      (a) => a.status === 401 && a.code === 'auth.unauthorized' && !a.hasIssues,
    )
    expect(
      unauthorized.length,
      `answered otherwise: ${listed(answers.filter((a) => !unauthorized.includes(a)))}`,
    ).toBe(routes.length)
  })

  it('AC-6: a signed-in customer gets 403 auth.forbidden with no issues from every /api/admin/* probe', async () => {
    const adminProbes = ADMIN_ROUTES.map(probeOf)
    const forbidden: Answer[] = []
    for (const probe of adminProbes) forbidden.push(await send(probe, customerToken))
    const gated = forbidden.filter(
      (a) => a.status === 403 && a.code === 'auth.forbidden' && !a.hasIssues,
    )
    expect(
      gated.length,
      `answered otherwise: ${listed(forbidden.filter((a) => !gated.includes(a)))}`,
    ).toBe(adminProbes.length)
  })

  it('AC-6: behind the gate the input is still read: an admin gets 400 from the /api/admin/* probes, a signed-in customer from the requireAuth probes', async () => {
    const adminProbes = ADMIN_ROUTES.map(probeOf)
    // Behind the gate the input is still read: every probe whose input fails, or that is a keyed admin write, is a
    // 400 for a caller who passes the gate. A read with no refusable input would run, so it is left out.
    const behind = [
      ...adminProbes.map((probe) => ({ probe, token: adminToken })),
      ...REQUIRE_AUTH_ROUTES.map(probeOf).map((probe) => ({ probe, token: customerToken })),
    ].filter(
      ({ probe }) =>
        probe.failing.length > 0 ||
        (!SAFE.has(probe.method) && probe.route.split(' ')[1]!.startsWith('/api/admin/')),
    )
    const answers: Array<Answer & { expected: string }> = []
    for (const { probe, token } of behind) {
      const expected = probe.failing.length > 0 ? 'validation.failed' : 'idempotency.key_invalid'
      answers.push({ ...(await send(probe, token)), expected })
    }
    const read = answers.filter((a) => a.status === 400 && a.code === a.expected)
    expect(
      read.length,
      `answered otherwise: ${listed(answers.filter((a) => !read.includes(a)))}`,
    ).toBe(behind.length)
  })

  it('AC-6: POST /api/admin/inventory/:variantId/adjust with an admin bearer: {} is 400 validation.failed and moves no stock; a valid body is 200 and moves the stock by its delta', async () => {
    const seeded = await seedVariant(k, 10)
    const stock = async () =>
      (await k.store.read((tx) => k.repos.variant.findById(tx, seeded.variantId)))!.stock
    const adjust = (body: unknown) =>
      fetch(new URL(`/api/admin/inventory/${seeded.variantId}/adjust`, served.baseUrl), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie: `${CSRF_COOKIE}=${csrf.cookie}`,
          [CSRF_HEADER]: csrf.token,
          authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(body),
      })

    const before = await stock()
    const empty = await adjust({})
    const emptyBody = (await empty.json()) as { error?: { code: string } }
    expect(empty.status, JSON.stringify(emptyBody)).toBe(400)
    expect(emptyBody.error?.code).toBe('validation.failed')
    expect(await stock()).toBe(before)

    const delta = 3
    const moved = await adjust({ delta, reason: 'manual' })
    expect(moved.status, await moved.clone().text()).toBe(200)
    expect(await stock()).toBe(before + delta)
  })
})
