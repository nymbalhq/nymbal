import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Review } from '@nymbalhq/types'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  anonymousSubmit,
  productIn,
  reviewer,
  reviewRows,
  submittedEvents,
  submitWithoutCsrf,
  writeOrders,
} from '../support/reviews.js'
import type { ShopResponse } from '../support/shopper.js'

// A signed-in shopper reviews a product over HTTP on a served SQLite kernel: the review waits for moderation as the
// caller's, never as whoever the body names; a guest or a request without its CSRF pair is refused before input; the
// schema bounds rating, title and body; only a product the store sells takes a review; one review.submitted.v1 per
// accepted review; and the public list publishes no customer or order id.

interface Issue {
  path: Array<string | number>
  message: string
}

const issuesOf = (res: ShopResponse<unknown>): Issue[] =>
  (res.body.error as { context?: { issues?: Issue[] } } | undefined)?.context?.issues ?? []

/**
 * Whether some issue names `field`: by its path (`body.rating`), or by its message, where Zod quotes an unrecognized
 * key (`Unrecognized key: "customerId"`).
 */
const names = (res: ShopResponse<unknown>, field: string): boolean =>
  issuesOf(res).some(
    (i) => i.path.join('.') === `body.${field}` || i.message.includes(`"${field}"`),
  )

const valid = (productId: string) => ({
  productId,
  rating: 4,
  title: 'Sturdy and true',
  body: 'Held up to a year of daily use.',
})

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminSession

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminSession(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

async function pendingIds(): Promise<string[]> {
  const res = await admin.send<Review[]>('GET', '/api/admin/reviews')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!.map((r) => r.id).sort()
}

async function publicItems(productId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${served.baseUrl}/api/products/${productId}/reviews`, {
    headers: { accept: 'application/json' },
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { items: Array<Record<string, unknown>> } }).data.items
}

describe('a signed-in shopper submits a review', () => {
  // Kills: no route (the form posts to nothing), or identity taken from the body.
  it("AC-1: a signed-in customer's valid POST /api/reviews answers 200 { review } pending, as the caller, with the body's rating, title and body; the admin pending list holds it and the public list does not", async () => {
    const productId = await productIn(k, 'active')
    const who = await reviewer(served.baseUrl)
    const body = valid(productId)

    const res = await who.submit(body)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const review = res.body.data!.review
    expect([
      review.moderationStatus,
      review.customerId,
      review.productId,
      review.rating,
      review.title,
      review.body,
    ]).toEqual(['pending', who.id, productId, body.rating, body.title, body.body])
    expect((await pendingIds()).filter((id) => id === review.id)).toEqual([review.id])
    expect((await publicItems(productId)).map((r) => r['id'])).toEqual([])
    expect((await reviewRows(raw, productId)).map((r) => [r.id, r.customerId])).toEqual([
      [review.id, who.id],
    ])
  })

  // Kills: a body that is not strict, so the caller names whose review it is, or whether it is verified.
  it('AC-1: a body carrying customerId, orderId, author or verified answers 400 validation.failed naming that key, and no row is written', async () => {
    const productId = await productIn(k, 'active')
    const who = await reviewer(served.baseUrl)
    const other = await reviewer(served.baseUrl)
    const [orderId] = await writeOrders(k, [
      { customerId: other.id, status: 'delivered', productIds: [productId], createdAt: new Date() },
    ])
    const extras: Record<string, unknown> = {
      customerId: other.id,
      orderId,
      author: { name: 'Someone Else', email: other.email },
      verified: true,
    }

    for (const [key, value] of Object.entries(extras)) {
      const res = await who.submit({ ...valid(productId), [key]: value })
      expect([res.status, res.body.error?.code], `${key}: ${JSON.stringify(res.body)}`).toEqual([
        400,
        'validation.failed',
      ])
      expect(names(res, key), `${key}: issues ${JSON.stringify(issuesOf(res))}`).toBe(true)
    }
    expect(await reviewRows(raw, productId)).toEqual([])
  })
})

describe('a review needs a session and a CSRF pair', () => {
  // Kills: the route not wrapped in requireAuth, or opted out of CSRF.
  it('AC-2: with a CSRF pair and no session the answer is 401 auth.unauthorized; with a session and no CSRF pair it is 403 csrf.invalid; the pending list is unchanged by either', async () => {
    const productId = await productIn(k, 'active')
    const who = await reviewer(served.baseUrl)
    const before = await pendingIds()

    const guest = await anonymousSubmit(served.baseUrl, valid(productId))
    const forged = await submitWithoutCsrf(served.baseUrl, who, valid(productId))

    expect([guest.status, guest.body.error?.code], JSON.stringify(guest.body)).toEqual([
      401,
      'auth.unauthorized',
    ])
    expect([forged.status, forged.code]).toEqual([403, 'csrf.invalid'])
    expect(await pendingIds()).toEqual(before)
    expect(await reviewRows(raw, productId)).toEqual([])
  })
})

describe('the schema bounds a review', () => {
  // Kills: a bound missing (no int, no max on title or body, body allowed blank) or a wrong type accepted.
  it('AC-3: rating 0, 6, 3.5 or "5", a body empty or only spaces, a 121-character title, a 2,001-character body and no productId each answer 400 validation.failed naming the field, and no row is written', async () => {
    const productId = await productIn(k, 'active')
    const who = await reviewer(served.baseUrl)
    const base = valid(productId)
    const { productId: _omitted, ...noProduct } = base
    const cases: Array<[string, string, unknown]> = [
      ['rating 0', 'rating', { ...base, rating: 0 }],
      ['rating 6', 'rating', { ...base, rating: 6 }],
      ['rating 3.5', 'rating', { ...base, rating: 3.5 }],
      ['rating "5"', 'rating', { ...base, rating: '5' }],
      ['an empty body', 'body', { ...base, body: '' }],
      ['a body of spaces', 'body', { ...base, body: '   ' }],
      ['a 121-character title', 'title', { ...base, title: 't'.repeat(121) }],
      ['a 2,001-character body', 'body', { ...base, body: 'b'.repeat(2001) }],
      ['no productId', 'productId', noProduct],
    ]

    for (const [label, field, body] of cases) {
      const res = await who.submit(body)
      expect([res.status, res.body.error?.code], `${label}: ${JSON.stringify(res.body)}`).toEqual([
        400,
        'validation.failed',
      ])
      expect(names(res, field), `${label}: issues ${JSON.stringify(issuesOf(res))}`).toBe(true)
    }
    expect(await reviewRows(raw, productId)).toEqual([])
  })

  // Kills: a bound off by one either way (title max 119 or 121, body max 1999 or 2001, rating 0-5 or 1-4).
  it('AC-3: property: over generated ratings, title and body lengths around their bounds, a submission is accepted exactly when rating is an integer 1-5, the title at most 120 characters and the trimmed body 1-2,000, and a refusal names exactly the fields out of bounds', async () => {
    const who = await reviewer(served.baseUrl)
    const near = (bound: number) =>
      fc.oneof(fc.integer({ min: bound - 2, max: bound + 2 }), fc.integer({ min: 0, max: bound }))
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: -1, max: 7 }),
          fc.double({ min: 0.5, max: 5.5, noNaN: true }).filter((n) => !Number.isInteger(n)),
        ),
        near(120),
        near(2000),
        async (rating, titleLength, bodyLength) => {
          const productId = await productIn(k, 'active')
          const body = {
            productId,
            rating,
            title: 't'.repeat(titleLength),
            body: 'b'.repeat(bodyLength),
          }
          const outOfBounds = [
            ...(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? [] : ['rating']),
            ...(titleLength <= 120 ? [] : ['title']),
            ...(bodyLength >= 1 && bodyLength <= 2000 ? [] : ['body']),
          ]
          const label = `rating ${rating}, title ${titleLength}, body ${bodyLength}`

          const res = await who.submit(body)

          const accepted = outOfBounds.length === 0
          expect(
            {
              status: res.status,
              code: res.body.error?.code,
              named: ['rating', 'title', 'body'].filter((field) => names(res, field)),
              rows: (await reviewRows(raw, productId)).length,
            },
            `${label}: ${JSON.stringify(res.body)}`,
          ).toEqual({
            status: accepted ? 200 : 400,
            code: accepted ? undefined : 'validation.failed',
            named: outOfBounds,
            rows: accepted ? 1 : 0,
          })
        },
      ),
      {
        numRuns: 30,
        examples: [
          [1, 120, 1],
          [5, 0, 2000],
          [0, 121, 2001],
        ],
      },
    )
  }, 120_000)
})

describe('only a product the store sells takes a review', () => {
  // Kills: reviews filed against any product id, or against products the store does not sell.
  it('AC-4: a product id that does not exist, a draft product and an archived product each answer 404 not_found and write no row, where the same body for an active product answers 200', async () => {
    const who = await reviewer(served.baseUrl)
    const unsold = {
      'an unknown id': `no-such-product-${randomUUID()}`,
      'a draft product': await productIn(k, 'draft'),
      'an archived product': await productIn(k, 'archived'),
    }
    const active = await productIn(k, 'active')

    for (const [label, productId] of Object.entries(unsold)) {
      const res = await who.submit(valid(productId))
      expect([res.status, res.body.error?.code], `${label}: ${JSON.stringify(res.body)}`).toEqual([
        404,
        'not_found',
      ])
      expect(await reviewRows(raw, productId), label).toEqual([])
    }
    const sold = await who.submit(valid(active))
    expect(sold.status, JSON.stringify(sold.body)).toBe(200)
    expect((await reviewRows(raw, active)).map((r) => r.id)).toEqual([sold.body.data!.review.id])
  })
})

describe('one event per accepted review, and a public list without identities', () => {
  // Kills: no event, an event per attempt, or an event whose payload is not the stored row.
  it('AC-13: exactly one review.submitted.v1 per accepted submission, its payload the stored row’s id, productId, customerId, orderId and rating; none for a 401, 400, 404 or 409 refusal', async () => {
    const productId = await productIn(k, 'active')
    const draft = await productIn(k, 'draft')
    const buyer = await reviewer(served.baseUrl)
    const browser = await reviewer(served.baseUrl)
    await writeOrders(k, [
      { customerId: buyer.id, status: 'delivered', productIds: [productId], createdAt: new Date() },
    ])
    const start = Math.max(0, ...(await submittedEvents(raw)).map((e) => e.seq))

    const accepted = [await buyer.submit(valid(productId)), await browser.submit(valid(productId))]
    for (const res of accepted) expect(res.status, JSON.stringify(res.body)).toBe(200)
    const afterAccepted = Math.max(start, ...(await submittedEvents(raw, start)).map((e) => e.seq))
    const refused = [
      await anonymousSubmit(served.baseUrl, valid(productId)),
      await buyer.submit({ ...valid(productId), rating: 9 }),
      await buyer.submit(valid(draft)),
      await buyer.submit(valid(productId)),
    ]

    expect(refused.map((r) => r.status)).toEqual([401, 400, 404, 409])
    const rows = await reviewRows(raw, productId)
    expect(
      (await submittedEvents(raw, start)).map((e) => e.payload),
      'the events after the four submissions',
    ).toEqual(
      accepted.map((res) => {
        const row = rows.find((r) => r.id === res.body.data!.review.id)!
        return {
          reviewId: row.id,
          productId: row.productId,
          customerId: row.customerId,
          orderId: row.orderId,
          rating: row.rating,
        }
      }),
    )
    expect(await submittedEvents(raw, afterAccepted), 'events from the refusals').toEqual([])
  })

  // Kills: the public list passing the adapter's rows whole (customerId and orderId published), or verified sent
  // rather than derived from the row.
  it('AC-13: property: over generated approved reviews with and without an order, GET /api/products/:id/reviews items carry exactly id, productId, rating, title, body, verified and submittedAt, with verified true exactly when the row’s orderId is not null', async () => {
    const reviews = k.app.adapters.reviews
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ bought: fc.boolean(), rating: fc.integer({ min: 1, max: 5 }) }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (generated) => {
          const productId = await productIn(k, 'active')
          for (const g of generated) {
            const who = await reviewer(served.baseUrl)
            const [orderId] = g.bought
              ? await writeOrders(k, [
                  {
                    customerId: who.id,
                    status: 'delivered',
                    productIds: [productId],
                    createdAt: new Date(),
                  },
                ])
              : [null]
            // Stored through the adapter as the kernel would hand it on, so the read is judged apart from the route.
            const { review } = await reviews.submitReview({
              productId,
              customerId: who.id,
              orderId: orderId ?? null,
              author: { name: `${who.firstName} ${who.lastName}`, email: who.email },
              rating: g.rating,
              title: `Rated ${g.rating}`,
              body: 'Seen in the public list.',
            })
            const moderated = await admin.send('POST', `/api/admin/reviews/${review.id}/moderate`, {
              status: 'approved',
            })
            expect(moderated.status, JSON.stringify(moderated.body)).toBe(200)
          }

          const items = await publicItems(productId)
          const rows = await reviewRows(raw, productId)
          const label = JSON.stringify(items)

          expect(
            items.map((item) => Object.keys(item).sort()),
            label,
          ).toEqual(
            rows.map(() => [
              'body',
              'id',
              'productId',
              'rating',
              'submittedAt',
              'title',
              'verified',
            ]),
          )
          const verifiedById = new Map(items.map((item) => [item['id'], item['verified']]))
          expect(
            rows.map((r) => [r.id, verifiedById.get(r.id)]),
            label,
          ).toEqual(rows.map((r) => [r.id, r.orderId !== null]))
          expect(rows.filter((r) => r.orderId !== null).length, label).toBe(
            generated.filter((g) => g.bought).length,
          )
        },
      ),
      { numRuns: 8 },
    )
  }, 120_000)
})
