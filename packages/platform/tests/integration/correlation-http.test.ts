import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CORRELATION_HEADER,
  correlationIdsOf,
  DECISION_3,
  eventsAfter,
  payloadOf,
  send,
  UUID_V7,
} from '../support/correlation.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Seeded } from '../support/kernel.js'
import { maxSeq, type EventRow } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { shopper } from '../support/shopper.js'

// Acceptance tests for P3-01 AC-2 and AC-3 (spec P3-01-event-log-surface, decisions 2 and 3) on SQLite: a kernel from
// `src/` served by the http package's `src/`. AC-2: every event a cart add or a registration publishes carries the
// request's id (the response's x-correlation-id), and two concurrent requests never share or swap ids. AC-3: a
// well-formed inbound x-correlation-id is used and echoed; a malformed one is replaced by a uuidv7, echoed and on the
// events; every response carries the header, Fastify's own 404 and body-parse 400 included. Events are read from the
// `events` table through a second connection. A newline cannot reach the store in a header (Node's HTTP parser answers
// 400 before Fastify sees the request), so that case is the unit test in src/events/correlation.test.ts.
// Kills: a scope that leaks across concurrent requests or is lost after an await, an inbound header used unvalidated,
// and a response without the header.

let served: ServedKernel
let raw: RawReader
let seeded: Seeded

beforeAll(async () => {
  const kernel = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(kernel)
  raw = openRaw('sqlite', kernel.target)
  seeded = await seedVariant(kernel, 100_000)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

/** A shopper holding a cart (and the CSRF cookie the security middleware wants), and the cart's token. */
async function shopperWithCart() {
  const s = shopper(served.baseUrl)
  const cart = await s.call('GET', '/api/cart')
  expect(cart.status, JSON.stringify(cart.body)).toBe(200)
  return { s, token: s.jar.get('nymbal.cart')! }
}

function addItem(s: ReturnType<typeof shopper>, headers: Record<string, string> = {}) {
  return s.call('POST', '/api/cart/items', { variantId: seeded.variantId, qty: 1 }, { headers })
}

function register(s: ReturnType<typeof shopper>, email: string) {
  return s.call('POST', '/api/auth/register', { email, password: 'p3-01-correct-horse' })
}

/** The rows above `before` whose payload names the cart. */
function ofCart(rows: EventRow[], token: string): EventRow[] {
  return rows.filter((row) => payloadOf(row)['cartId'] === token)
}

/** The rows above `before` that the registration of `email` published: its customer.created and anything naming it. */
function ofCustomer(rows: EventRow[], email: string): EventRow[] {
  const ids = new Set(
    rows
      .filter((row) => payloadOf(row)['email'] === email)
      .map((row) => payloadOf(row)['customerId']),
  )
  return rows.filter(
    (row) => payloadOf(row)['email'] === email || ids.has(payloadOf(row)['customerId']),
  )
}

describe('P3-01 AC-2: every event an HTTP request publishes carries the request’s id', () => {
  it('AC-2: a cart add: every event it publishes carries the response’s x-correlation-id', async () => {
    const { s, token } = await shopperWithCart()
    const before = await maxSeq(raw)
    const res = await addItem(s)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = await eventsAfter(raw, before)
    expect(ofCart(rows, token).length, 'cart events for the add').toBeGreaterThan(0)

    expect(correlationIdsOf(rows)).toEqual(rows.map(() => res.headers.get(CORRELATION_HEADER)))
    expect(DECISION_3.test(res.headers.get(CORRELATION_HEADER) ?? '')).toBe(true)
  })

  it('AC-2: a customer registration: every event it publishes carries the response’s x-correlation-id', async () => {
    const { s } = await shopperWithCart()
    const email = `ac2-${randomUUID()}@p3-01.test`
    const before = await maxSeq(raw)
    const res = await register(s, email)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const rows = await eventsAfter(raw, before)
    expect(ofCustomer(rows, email).length, 'customer.created for the registration').toBeGreaterThan(
      0,
    )

    expect(correlationIdsOf(rows)).toEqual(rows.map(() => res.headers.get(CORRELATION_HEADER)))
    expect(DECISION_3.test(res.headers.get(CORRELATION_HEADER) ?? '')).toBe(true)
  })

  it('AC-2: property (20 pairs): two concurrent requests (Promise.all of cart adds and registrations) each publish under exactly one id, their own response’s, and the two sets are disjoint', async () => {
    type Kind = 'cart' | 'register'
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.constantFrom<Kind>('cart', 'register'),
          fc.constantFrom<Kind>('cart', 'register'),
        ),
        async (kinds) => {
          const sides = await Promise.all(
            kinds.map(async (kind) => ({
              kind,
              email: `ac2-${randomUUID()}@p3-01.test`,
              ...(await shopperWithCart()),
            })),
          )
          const before = await maxSeq(raw)
          const answers = await Promise.all(
            sides.map((side) =>
              side.kind === 'cart' ? addItem(side.s) : register(side.s, side.email),
            ),
          )
          answers.forEach((answer, i) => {
            expect(answer.status, JSON.stringify(answer.body)).toBe(
              sides[i]!.kind === 'cart' ? 200 : 201,
            )
          })
          const rows = await eventsAfter(raw, before)

          const sets = sides.map(
            (side) =>
              new Set(
                correlationIdsOf(
                  side.kind === 'cart' ? ofCart(rows, side.token) : ofCustomer(rows, side.email),
                ),
              ),
          )
          sets.forEach((ids, i) => {
            expect([...ids], `${sides[i]!.kind} request ${i}: the ids its events carry`).toEqual([
              answers[i]!.headers.get(CORRELATION_HEADER),
            ])
          })
          expect(
            [...sets[0]!].filter((id) => sets[1]!.has(id)),
            'ids shared by the two requests',
          ).toEqual([])
        },
      ),
      { numRuns: 20, endOnFailure: true },
    )
  }, 120_000)
})

/** The value the store sees for a header sent as `sent`: HTTP drops leading and trailing spaces and tabs. */
function asReceived(sent: string): string {
  return sent.replace(/^[ \t]+|[ \t]+$/g, '')
}

describe('P3-01 AC-3: the inbound x-correlation-id is used only when well formed, and every response echoes one', () => {
  it('AC-3: a well-formed inbound id is echoed and is the id on the events', async () => {
    const { s } = await shopperWithCart()
    const inbound = `ac3.shop:${randomUUID()}`
    const before = await maxSeq(raw)
    const res = await addItem(s, { [CORRELATION_HEADER]: inbound })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = await eventsAfter(raw, before)
    expect(rows.length).toBeGreaterThan(0)

    expect(res.headers.get(CORRELATION_HEADER)).toBe(inbound)
    expect(correlationIdsOf(rows)).toEqual(rows.map(() => inbound))
  })

  it.each([
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a space', 'has space'],
    ['<script>', '<script>'],
    ['non-ASCII', 'café-ÿ'],
  ])(
    'AC-3: a malformed inbound id (%s) is replaced by a uuidv7, which is echoed and is the id on the events',
    async (_name, inbound) => {
      const { s } = await shopperWithCart()
      const before = await maxSeq(raw)
      const res = await addItem(s, { [CORRELATION_HEADER]: inbound })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const rows = await eventsAfter(raw, before)
      expect(rows.length).toBeGreaterThan(0)
      const echoed = res.headers.get(CORRELATION_HEADER)

      expect(echoed !== null && UUID_V7.test(echoed), `echoed ${JSON.stringify(echoed)}`).toBe(true)
      expect(echoed === inbound).toBe(false)
      expect(correlationIdsOf(rows)).toEqual(rows.map(() => echoed))
    },
  )

  it('AC-3: property: whatever string is sent as x-correlation-id, the echoed id matches decision 3: the value itself when well formed, else a fresh uuidv7', async () => {
    const latin1 = fc
      .integer({ min: 0x20, max: 0xff })
      .filter((c) => c !== 0x7f)
      .map((c) => String.fromCharCode(c))
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/),
          fc.string({ unit: latin1, maxLength: 140 }),
          fc.string({
            unit: fc.constantFrom('a', '9', '.', ':', '-', '_', ' ', '\t', '<', '/'),
            maxLength: 130,
          }),
        ),
        async (sent) => {
          const res = await send(served.baseUrl, {
            method: 'GET',
            path: '/api/products?limit=1',
            headers: { [CORRELATION_HEADER]: sent },
          })
          const received = asReceived(sent)
          const echoed = res.correlationId ?? ''

          expect(
            DECISION_3.test(echoed),
            `sent ${JSON.stringify(sent)}, echoed ${JSON.stringify(echoed)}`,
          ).toBe(true)
          // Well formed: the value itself; otherwise a fresh uuidv7.
          expect(
            DECISION_3.test(received) ? echoed === received : UUID_V7.test(echoed),
            `sent ${JSON.stringify(sent)}, echoed ${JSON.stringify(echoed)}`,
          ).toBe(true)
        },
      ),
      { numRuns: 150, endOnFailure: true },
    )
  }, 60_000)

  it('AC-3: every response carries the header: a 200, Fastify’s own 404 for an unmatched route (a well-formed inbound id echoed), and its body-parse 400 (a fresh uuidv7)', async () => {
    const inbound = `ac3.404:${randomUUID()}`
    const ok = await send(served.baseUrl, { method: 'GET', path: '/api/products?limit=1' })
    const missing = await send(served.baseUrl, {
      method: 'GET',
      path: `/api/no-such-route-${randomUUID()}`,
      headers: { [CORRELATION_HEADER]: inbound },
    })
    const { s } = await shopperWithCart()
    const csrf = s.jar.get('nymbal.csrf') ?? ''
    const unparsable = await send(served.baseUrl, {
      method: 'POST',
      path: '/api/cart/items',
      headers: {
        'content-type': 'application/json',
        cookie: [...s.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
      },
      body: '{"variantId":',
    })

    expect([ok.status, missing.status, unparsable.status]).toEqual([200, 404, 400])
    expect(
      [ok, missing, unparsable].map(
        (r) => r.correlationId !== null && DECISION_3.test(r.correlationId),
      ),
      'each response has a well-formed x-correlation-id',
    ).toEqual([true, true, true])
    expect(missing.correlationId).toBe(inbound)
    expect(UUID_V7.test(unparsable.correlationId ?? ''), String(unparsable.correlationId)).toBe(
      true,
    )
  })
})
