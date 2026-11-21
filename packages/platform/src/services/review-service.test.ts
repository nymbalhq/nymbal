import { describe, expect, it } from 'vitest'
import {
  EVT_REVIEW_SUBMITTED,
  NotFoundError,
  ReviewRefusedError,
  type OrderStatus,
  type Review,
  type ReviewSubmission,
  type ReviewsAdapter,
} from '@nymbalhq/types'
import { createLogger } from '../logger.js'
import {
  createReviewService,
  REVIEW_VERIFYING_STATUSES,
  type ReviewServiceDeps,
} from './review-service.js'

// A review is filed only for an active product, through an adapter that takes submissions, by a customer who exists;
// it goes in under the customer's name and their newest paid order holding the product, and what the adapter stored
// is what the event announces. The store, repositories and adapter are in memory: the integration suites hold the
// same service on SQLite and over HTTP.

type Customer = { id: string; email: string; firstName: string; lastName: string }
type Order = { id: string; customerId: string; productId: string; status: OrderStatus }

function world(
  opts: {
    product?: { id: string; status: string } | null
    customer?: Customer | null
    orders?: Order[]
    capabilities?: string[]
  } = {},
) {
  const product = opts.product === undefined ? { id: 'p1', status: 'active' } : opts.product
  const customer =
    opts.customer === undefined
      ? { id: 'c1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' }
      : opts.customer
  const orders = opts.orders ?? []
  const stored: ReviewSubmission[] = []
  const published: Array<{ type: string; payload: Record<string, unknown> }> = []
  const reviews = {
    capabilities: () => opts.capabilities ?? ['read', 'submit'],
    async submitReview(submission: ReviewSubmission) {
      stored.push(submission)
      const review = {
        ...submission,
        id: `r${stored.length}`,
        rating: Math.min(5, submission.rating),
      } as unknown as Review
      return { review }
    },
  } as unknown as ReviewsAdapter
  const deps = {
    store: {
      read: (fn: (tx: unknown) => unknown) => fn({}),
      transaction: (fn: (tx: unknown) => unknown) => fn({}),
    },
    repos: {
      product: {
        findById: async (_tx: unknown, id: string) => (product?.id === id ? product : null),
      },
      customer: {
        findById: async (_tx: unknown, id: string) => (customer?.id === id ? customer : null),
      },
      order: {
        newestHolding: async (
          _tx: unknown,
          customerId: string,
          productId: string,
          statuses: readonly OrderStatus[],
        ) =>
          orders.findLast(
            (o) =>
              o.customerId === customerId &&
              o.productId === productId &&
              statuses.includes(o.status),
          ) ?? null,
      },
    },
    publisher: {
      publish: async (type: string, payload: Record<string, unknown>) => {
        published.push({ type, payload })
      },
    },
    reviews,
    logger: createLogger({ pretty: false, level: 'error' }),
  } as unknown as ReviewServiceDeps
  return { service: createReviewService(deps), stored, published }
}

const input = { customerId: 'c1', productId: 'p1', rating: 4, title: 'Good', body: 'Soft.' }

describe('review submission', () => {
  it('files under the customer’s name, joined from the parts they gave', async () => {
    const names: Array<[string, string, string]> = [
      ['Ann', 'Lee', 'Ann Lee'],
      ['Ann', '', 'Ann'],
      ['', 'Lee', 'Lee'],
      ['', '', ''],
    ]
    for (const [firstName, lastName, expected] of names) {
      const { service, stored } = world({
        customer: { id: 'c1', email: 'ann@example.com', firstName, lastName },
      })
      await service.submit(input)
      expect(stored.map((s) => s.author)).toEqual([{ name: expected, email: 'ann@example.com' }])
    }
  })

  it('verifies by the newest order that paid for the product, and by none that was cancelled', async () => {
    const order = (id: string, status: OrderStatus): Order => ({
      id,
      customerId: 'c1',
      productId: 'p1',
      status,
    })
    for (const status of ['pending', 'cancelled'] as OrderStatus[]) {
      const { service, stored } = world({ orders: [order('o-unpaid', status)] })
      await service.submit(input)
      expect(stored.map((s) => s.orderId)).toEqual([null])
    }
    for (const status of REVIEW_VERIFYING_STATUSES) {
      const { service, stored } = world({
        orders: [
          order('o-old', 'delivered'),
          order('o-new', status),
          order('o-cancelled', 'cancelled'),
        ],
      })
      await service.submit(input)
      expect(stored.map((s) => s.orderId)).toEqual(['o-new'])
    }
  })

  it('announces what the adapter stored, not what was asked', async () => {
    const { service, published } = world()
    const review = await service.submit({ ...input, rating: 9 })
    // The adapter keeps ratings to five: the event carries its rating, below the one asked.
    expect(review.rating).toBeLessThan(9)
    expect(published).toEqual([
      {
        type: EVT_REVIEW_SUBMITTED,
        payload: {
          reviewId: review.id,
          productId: 'p1',
          customerId: 'c1',
          orderId: null,
          rating: 5,
        },
      },
    ])
  })

  it('refuses a product that is missing or not active, an adapter that takes no submissions and an unknown customer, storing and announcing nothing', async () => {
    const cases: Array<{ opts: Parameters<typeof world>[0]; error: object }> = [
      { opts: { product: null }, error: new NotFoundError('product', 'p1') },
      {
        opts: { product: { id: 'p1', status: 'draft' } },
        error: new NotFoundError('product', 'p1'),
      },
      { opts: { capabilities: ['read'] }, error: new ReviewRefusedError('submit_unsupported') },
      { opts: { customer: null }, error: new NotFoundError('customer', 'c1') },
    ]
    for (const c of cases) {
      const { service, stored, published } = world(c.opts)
      const refused = await service.submit(input).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(refused).toBeInstanceOf(c.error.constructor)
      expect((refused as Error).message).toBe((c.error as Error).message)
      expect([stored.length, published.length]).toEqual([0, 0])
    }
  })
})
