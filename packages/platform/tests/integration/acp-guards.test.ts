import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ERROR,
  ACP_KEY,
  acpClient,
  acpStore,
  cartPairs,
  cartOverHttp,
  createBody,
  PINNED_VERSION,
  seedPool,
  sptPayment,
  type AcpAnswer,
  type AcpClient,
  type AcpHeaders,
  type AcpSession,
  type PoolVariant,
} from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'
import { committedCount } from '../support/mcp.js'

// AC-3: every ACP route checks, in order, the bearer (401), API-Version (400, naming the one version served) and, on a
// POST, Idempotency-Key (400), before it reads or writes anything; every answer echoes Request-Id, and every POST
// answer echoes its Idempotency-Key.

let store: AgentStore
let agent: AcpClient
let pool: PoolVariant[]
/** A live session whose cart each refused request must leave as it was. */
let session: string

beforeAll(async () => {
  store = await acpStore()
  agent = acpClient(store.baseUrl)
  pool = await seedPool(store, [
    { priceMinor: 1500, stock: 50 },
    { priceMinor: 2250, stock: 50 },
  ])
  const created = await agent.create(createBody([{ variantId: pool[0]!.variantId, quantity: 2 }]))
  // Without a session the :id routes still answer, and the comparison below names what they answered.
  session = created.status === 201 ? created.body.id : `cs-not-opened-${randomUUID()}`
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

interface Route {
  label: string
  send(client: AcpClient, headers: AcpHeaders): Promise<AcpAnswer<AcpSession>>
  post: boolean
}

/** The six routes, each with a body it would act on were it let through. */
function routes(): Route[] {
  const other = [{ variantId: pool[1]!.variantId, quantity: 1 }]
  return [
    {
      label: 'POST /checkout_sessions',
      post: true,
      send: (c, h) => c.create(createBody(other), h),
    },
    { label: 'GET /checkout_sessions/:id', post: false, send: (c, h) => c.get(session, h) },
    {
      label: 'POST /checkout_sessions/:id',
      post: true,
      send: (c, h) =>
        c.update(session, { line_items: [{ id: other[0]!.variantId, quantity: 1 }] }, h),
    },
    {
      label: 'POST /checkout_sessions/:id/complete',
      post: true,
      send: (c, h) => c.complete(session, sptPayment(), h),
    },
    {
      label: 'POST /checkout_sessions/:id/cancel',
      post: true,
      send: (c, h) => c.cancel(session, h),
    },
    { label: 'GET /feed', post: false, send: (c, h) => c.request('GET', '/feed', undefined, h) },
  ]
}

interface Refusal {
  label: string
  client: () => AcpClient
  headers: AcpHeaders
  /** Only POSTs can be refused for the key. */
  postOnly?: boolean
  status: number
  code: string
}

const sameLength = (key: string) => `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`

function refusals(): Refusal[] {
  return [
    {
      label: 'no bearer',
      client: () => agent,
      headers: { authorization: null },
      status: 401,
      code: 'unauthorized',
    },
    {
      label: 'a wrong bearer',
      client: () => acpClient(store.baseUrl, { key: 'not-the-store-key' }),
      headers: {},
      status: 401,
      code: 'unauthorized',
    },
    {
      label: 'a wrong bearer of the same length',
      client: () => acpClient(store.baseUrl, { key: sameLength(ACP_KEY) }),
      headers: {},
      status: 401,
      code: 'unauthorized',
    },
    {
      label: 'no bearer, no API-Version and no Idempotency-Key (the bearer is checked first)',
      client: () => agent,
      headers: { authorization: null, 'api-version': null, 'idempotency-key': null },
      status: 401,
      code: 'unauthorized',
    },
    {
      label: 'no API-Version',
      client: () => agent,
      headers: { 'api-version': null },
      status: 400,
      code: 'missing_api_version',
    },
    {
      label: 'API-Version 2025-09-29',
      client: () => agent,
      headers: { 'api-version': '2025-09-29' },
      status: 400,
      code: 'unsupported_api_version',
    },
    {
      label: 'no API-Version and no Idempotency-Key (the version is checked before the key)',
      client: () => agent,
      headers: { 'api-version': null, 'idempotency-key': null },
      status: 400,
      code: 'missing_api_version',
    },
    {
      label: 'no Idempotency-Key',
      client: () => agent,
      headers: { 'idempotency-key': null },
      postOnly: true,
      status: 400,
      code: 'idempotency_key_required',
    },
    {
      label: 'an Idempotency-Key of 256 characters',
      client: () => agent,
      headers: { 'idempotency-key': 'k'.repeat(256) },
      postOnly: true,
      status: 400,
      code: 'idempotency_key_required',
    },
  ]
}

describe('AC-3: every ACP route refuses an unauthorised, unversioned or unkeyed request before it reads or writes', () => {
  // Kills: an unauthenticated agent opening carts, completing or cancelling a session or reading the feed; a version
  // mismatch served; the checks run in another order; the bearer compared by length or prefix.
  it('AC-3: for each of the six routes and each refusal, the status and code are the refusal’s, the body is an ACP Error (supported_versions ["2026-04-17"] on both version errors), Request-Id is echoed, a POST that carried a key echoes it, and the cart count, the order count and the session’s cart lines are as before', async () => {
    const linesBefore = cartPairs(await cartOverHttp(store.baseUrl, session))
    const cartsBefore = committedCount(store.kernel.target, 'carts')
    const ordersBefore = committedCount(store.kernel.target, 'orders')
    const seen: string[] = []
    const wanted: string[] = []

    for (const route of routes()) {
      for (const refusal of refusals()) {
        if (refusal.postOnly === true && !route.post) continue
        const requestId = `req-${randomUUID()}`
        const key = `acp-${randomUUID()}`
        const sentKey =
          refusal.headers['idempotency-key'] !== undefined
            ? refusal.headers['idempotency-key']
            : key
        const answer = await route.send(refusal.client(), {
          ...(route.post && { 'idempotency-key': key }),
          ...refusal.headers,
          'request-id': requestId,
        })
        const label = `${route.label}, ${refusal.label}`
        const versionError = refusal.code.endsWith('api_version')

        seen.push(
          JSON.stringify({
            label,
            status: answer.status,
            code: answer.body.code,
            schema: validateAcp(ACP_ERROR, answer.body),
            supported: versionError ? answer.body.supported_versions : null,
            requestId: answer.headers.get('request-id'),
            key: route.post && sentKey !== null ? answer.headers.get('idempotency-key') : null,
          }),
        )
        wanted.push(
          JSON.stringify({
            label,
            status: refusal.status,
            code: refusal.code,
            schema: [],
            supported: versionError ? [PINNED_VERSION] : null,
            requestId,
            key: route.post && sentKey !== null ? sentKey : null,
          }),
        )
      }
    }

    const cartsAfter = committedCount(store.kernel.target, 'carts')
    const ordersAfter = committedCount(store.kernel.target, 'orders')

    expect(seen).toEqual(wanted)
    expect([cartsAfter, ordersAfter]).toEqual([cartsBefore, ordersBefore])
    expect(cartPairs(await cartOverHttp(store.baseUrl, session))).toEqual(linesBefore)
  })

  // Kills: headers echoed only on errors, or the key echoed from another request.
  it('AC-3: an accepted create, update and get echo Request-Id, and the create and update echo their own Idempotency-Key', async () => {
    const answers: Array<{
      sent: { requestId: string; key: string | null }
      got: AcpAnswer<AcpSession>
    }> = []
    for (const send of [
      (h: AcpHeaders) =>
        agent.create(createBody([{ variantId: pool[1]!.variantId, quantity: 1 }]), h),
      (h: AcpHeaders) =>
        agent.update(session, { buyer: { email: `echo-${randomUUID()}@acp.test` } }, h),
      (h: AcpHeaders) => agent.get(session, h),
    ]) {
      const requestId = `req-${randomUUID()}`
      const key = answers.length < 2 ? `acp-${randomUUID()}` : null
      const got = await send({
        'request-id': requestId,
        ...(key !== null && { 'idempotency-key': key }),
      })
      answers.push({ sent: { requestId, key }, got })
    }

    expect(answers.map((a) => a.got.status)).toEqual([201, 200, 200])
    expect(
      answers.map((a) => ({
        requestId: a.got.headers.get('request-id'),
        key: a.sent.key === null ? null : a.got.headers.get('idempotency-key'),
      })),
    ).toEqual(answers.map((a) => a.sent))
  })
})
