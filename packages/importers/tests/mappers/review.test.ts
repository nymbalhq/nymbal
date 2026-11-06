import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapReview } from '../../src/woocommerce/mappers/review.js'
import type { WcReview } from '../../src/woocommerce/client.js'

function makeReview(overrides: Partial<WcReview> = {}): WcReview {
  return {
    id: 7,
    product_id: 100,
    reviewer: 'Alice',
    reviewer_email: 'alice@example.com',
    review: '<p>Soft and <strong>well cut</strong></p>',
    rating: 4,
    verified: true,
    date_created: '2024-02-01T09:00:00',
    ...overrides,
  }
}

describe('mapReview', () => {
  it('rates inside 1 to 5: a rating in range is kept, one outside lands on the nearer bound', () => {
    fc.assert(
      fc.property(fc.integer({ min: -20, max: 25 }), (rating) => {
        const mapped = mapReview(makeReview({ rating }), 'p', null).rating
        const nearest = rating < 1 ? 1 : rating > 5 ? 5 : rating
        expect(mapped).toBe(nearest)
      }),
    )
  })

  it('keeps the text of the review without its markup or surrounding space', () => {
    const mapped = mapReview(
      makeReview({ review: '  <p>Soft and <strong>well cut</strong><br/></p>\n' }),
      'p',
      null,
    )
    expect(mapped.body).toBe('Soft and well cut')
  })

  it('submits under the Nymbal product and customer, with no order, author or title', () => {
    expect(mapReview(makeReview(), 'nymbal-product', 'nymbal-customer')).toEqual({
      productId: 'nymbal-product',
      customerId: 'nymbal-customer',
      orderId: null,
      author: null,
      rating: 4,
      title: '',
      body: 'Soft and well cut',
    })
  })
})
