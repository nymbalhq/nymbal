import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AdminReview, ReviewModerationStatus } from '@nymbalhq/types'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { unaudited } from '../support/write-audit.js'

// The admin's review moderation over HTTP on a served SQLite kernel: the list answers the reviews of the status asked
// for (pending when none is), a decision can be changed and each one takes, a review is public and counted in its
// product's rating exactly while it is approved, and a decision about a review that does not exist is refused without
// a write. Reviews are written straight to the command store with distinct submission times, so newest first is one
// order; everything asserted is read back over HTTP or by a second connection.

const STATUSES: readonly ReviewModerationStatus[] = ['pending', 'approved', 'rejected']

interface OwnProduct {
  id: string
  slug: string
  name: string
}

interface StoredReview {
  id: string
  status: string
  moderatedAt: string | null
  moderatedBy: string | null
}

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

/** An active product of the test's own, with one variant. */
async function ownProduct(): Promise<OwnProduct> {
  const tag = randomUUID()
  const slug = `moderated-${tag}`
  const name = `Moderated ${tag.slice(0, 8)}`
  const product = await k.services.product.create({
    slug,
    name,
    description: '',
    status: 'active',
    variants: [{ sku: `MOD-${tag}`, name: 'Default', priceMinor: 1500, stock: 10, options: [] }],
  })
  return { id: product.id, slug, name }
}

// Every review this file writes is submitted one second after the last, so no two share a submission time.
let clock = Date.parse('2026-01-01T00:00:00.000Z')

/** Writes one review of `productId` in `status`, outside the write audit; returns its id. */
async function seedReview(
  productId: string,
  status: ReviewModerationStatus,
  rating = 4,
): Promise<string> {
  const id = uuidv7()
  clock += 1000
  const submittedAt = new Date(clock)
  await unaudited(() =>
    k.store.transaction((tx) =>
      k.repos.review.insert(tx, {
        id,
        productId,
        customerId: null,
        orderId: null,
        rating,
        title: `Review ${id.slice(-6)}`,
        body: 'A review of the moderation test.',
        moderationStatus: status,
        submittedAt,
      }),
    ),
  )
  return id
}

/** Every review of the store as a second connection reads it, newest first. */
async function storedReviews(): Promise<Array<StoredReview & { submittedAt: string }>> {
  const rows = await raw.rows<{
    id: string
    moderation_status: string
    moderated_at: string | null
    moderated_by: string | null
    submitted_at: string
  }>(
    'SELECT id, moderation_status, moderated_at, moderated_by, submitted_at FROM reviews ORDER BY submitted_at DESC',
  )
  return rows.map((r) => ({
    id: r.id,
    status: r.moderation_status,
    moderatedAt: r.moderated_at,
    moderatedBy: r.moderated_by,
    submittedAt: r.submitted_at,
  }))
}

async function storedReview(id: string): Promise<StoredReview> {
  const found = (await storedReviews()).find((r) => r.id === id)
  if (found === undefined) throw new Error(`no review row ${id}`)
  return found
}

async function adminList(query = ''): Promise<AdminReview[]> {
  const res = await admin.send<AdminReview[]>('GET', `/api/admin/reviews${query}`)
  expect(res.status, `GET /api/admin/reviews${query}: ${JSON.stringify(res.body)}`).toBe(200)
  return res.body.data!
}

async function publicIds(productId: string): Promise<string[]> {
  const res = await fetch(`${served.baseUrl}/api/products/${productId}/reviews?limit=100`, {
    headers: { accept: 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { items: Array<{ id: string }> } }
  return body.data.items.map((r) => r.id).sort()
}

/** The approved count the product's own read serves: its rating's count, or 0 when it serves no rating. */
async function ratingCount(slug: string): Promise<number> {
  const res = await fetch(`${served.baseUrl}/api/products/${slug}`, {
    headers: { accept: 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { rating: { count: number } | null } }
  return body.data.rating?.count ?? 0
}

describe('the admin lists the reviews of one status', () => {
  // Kills: the status query ignored (the Approved tab shows the pending queue); a list in submission order rather
  // than newest first; a product's name read when the review was written rather than now; an unknown status listed.
  it('AC-1: with no status and with status=pending the list is the same pending reviews; approved and rejected answer theirs, newest first, each with its product’s current name and slug; every review is in exactly the list of its status; status=other is 400 validation.failed', async () => {
    const products = [await ownProduct(), await ownProduct()]
    // Interleaved across products and statuses, so neither insertion order nor product groups the lists.
    for (let i = 0; i < 9; i += 1) {
      await seedReview(products[i % 2]!.id, STATUSES[(i * 2) % 3]!)
    }
    const renamed = `${products[1]!.name} renamed`
    const patched = await admin.send('PATCH', `/api/admin/products/${products[1]!.id}`, {
      name: renamed,
    })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    const current = new Map([
      [products[0]!.id, { name: products[0]!.name, slug: products[0]!.slug }],
      [products[1]!.id, { name: renamed, slug: products[1]!.slug }],
    ])
    const stored = await storedReviews()

    const lists = {
      pending: await adminList('?status=pending'),
      approved: await adminList('?status=approved'),
      rejected: await adminList('?status=rejected'),
    }
    const unfiltered = await adminList()

    for (const status of STATUSES) {
      const list = lists[status]
      expect(
        list.map((r) => r.id),
        `?status=${status}: the stored reviews of that status, newest first`,
      ).toEqual(stored.filter((r) => r.status === status).map((r) => r.id))
      expect(
        list.map((r) => [r.id, r.moderationStatus, r.productName, r.productSlug]),
        `?status=${status}: each row's status and its product as it is now`,
      ).toEqual(
        list.map((r) => [
          r.id,
          status,
          current.get(r.productId)?.name,
          current.get(r.productId)?.slug,
        ]),
      )
    }
    expect(unfiltered.map((r) => r.id)).toEqual(lists.pending.map((r) => r.id))
    const listed = STATUSES.flatMap((s) => lists[s].map((r) => r.id))
    expect([...listed].sort(), 'every review in exactly one list').toEqual(
      stored.map((r) => r.id).sort(),
    )

    const other = await admin.send('GET', '/api/admin/reviews?status=other')
    expect([other.status, other.body.error?.code], JSON.stringify(other.body)).toEqual([
      400,
      'validation.failed',
    ])
  })
})

describe('a decision takes, and a review is public exactly while approved', () => {
  // Kills: a second decision that does not take (an update conditioned on pending); moderatedBy or moderatedAt left
  // from the first decision; a public list or a rating count that disagrees with the stored status; the admin list of
  // the new status not holding the review (a changed decision unreachable from its tab).
  it('AC-2: property: for any sequence of approved/rejected decisions on one review, after each the stored status, moderatedBy admin:<caller> and a moderatedAt within the request match it, the review is in its status’s admin list only, in GET /api/products/:id/reviews exactly when approved, and the product’s rating count equals its approved reviews', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<ReviewModerationStatus>(...STATUSES), { maxLength: 3 }),
        fc.array(fc.constantFrom<'approved' | 'rejected'>('approved', 'rejected'), {
          minLength: 1,
          maxLength: 5,
        }),
        async (others, decisions) => {
          const product = await ownProduct()
          const otherIds = new Map<string, ReviewModerationStatus>()
          for (const status of others) otherIds.set(await seedReview(product.id, status), status)
          const approvedOthers = [...otherIds].filter(([, s]) => s === 'approved').map(([id]) => id)
          const id = await seedReview(product.id, 'pending')
          const label = `others ${JSON.stringify(others)}, decisions ${JSON.stringify(decisions)}`

          for (const [step, decision] of decisions.entries()) {
            const at = `${label}, decision ${step + 1} (${decision})`
            const sentAt = Date.now()
            const res = await admin.send('POST', `/api/admin/reviews/${id}/moderate`, {
              status: decision,
            })
            const answeredAt = Date.now()
            expect(res.status, `${at}: ${JSON.stringify(res.body)}`).toBe(200)

            const row = await storedReview(id)
            expect([row.status, row.moderatedBy], at).toEqual([decision, `admin:${admin.userId}`])
            const moderatedAt = Date.parse(row.moderatedAt ?? '')
            expect(moderatedAt, `${at}: moderatedAt`).toBeGreaterThanOrEqual(sentAt - 1)
            expect(moderatedAt, `${at}: moderatedAt`).toBeLessThanOrEqual(answeredAt + 1)

            const holding: string[] = []
            for (const status of STATUSES) {
              if ((await adminList(`?status=${status}`)).some((r) => r.id === id)) {
                holding.push(status)
              }
            }
            expect(holding, `${at}: the admin lists holding the review`).toEqual([decision])

            const approved = decision === 'approved' ? [...approvedOthers, id] : approvedOthers
            expect(await publicIds(product.id), `${at}: the public list`).toEqual(
              [...approved].sort(),
            )
            expect(await ratingCount(product.slug), `${at}: the rating count`).toBe(approved.length)
          }
        },
      ),
      {
        // Each run creates a product and reads every list after each decision.
        numRuns: 6,
        endOnFailure: true,
        examples: [
          [[], ['approved', 'rejected', 'approved']],
          [
            ['approved', 'pending'],
            ['rejected', 'approved'],
          ],
        ],
      },
    )
  }, 120_000)
})

describe('a decision about no review is refused', () => {
  // Kills: the route answering { ok: true } for an update that matched no row, so the page reports a decision that
  // never happened.
  it('AC-3: POST /api/admin/reviews/<an id no review has>/moderate answers 404 not_found for either decision, and no review’s status, moderatedAt or moderatedBy changes', async () => {
    const product = await ownProduct()
    await seedReview(product.id, 'pending')
    const decided = await seedReview(product.id, 'pending')
    const first = await admin.send('POST', `/api/admin/reviews/${decided}/moderate`, {
      status: 'approved',
    })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const before = await storedReviews()

    const answers: Array<[number, string | undefined]> = []
    for (const status of ['approved', 'rejected'] as const) {
      const res = await admin.send('POST', `/api/admin/reviews/${uuidv7()}/moderate`, { status })
      answers.push([res.status, res.body.error?.code])
    }

    expect(answers).toEqual([
      [404, 'not_found'],
      [404, 'not_found'],
    ])
    expect(await storedReviews()).toEqual(before)
  })
})
