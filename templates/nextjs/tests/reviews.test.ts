import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PRODUCT_SORT, PRODUCT_SORT_KEYS, type StoreCapabilities } from '@nymbalhq/types'
import { acceptsReviews } from '@/lib/reviews'

// The product page renders the review form only for a store whose reviews adapter takes reviews on the site: its
// capabilities report lists `submit`. A provider that collects reviews elsewhere (by invitation, on its own site) gets
// the review list and no form; no report at all (the API unreachable at render) gets no form either.

const REVIEWS_CAPABILITIES = ['submit', 'moderate', 'aggregate', 'invite', 'widget']
/** What the native reviews adapter reports. */
const NATIVE = ['submit', 'moderate', 'aggregate']

function report(reviews: string[]): StoreCapabilities {
  return {
    payments: { capabilities: ['intent', 'capture', 'refund'], client: null },
    search: { capabilities: ['index', 'search', 'facet'] },
    catalog: { sortKeys: [...PRODUCT_SORT_KEYS], defaultSort: DEFAULT_PRODUCT_SORT },
    email: { delivers: false },
    reviews: { capabilities: reviews },
    shipping: { capabilities: [] },
  }
}

describe('acceptsReviews (nextjs)', () => {
  // Kills: the form shown unconditionally, or on a flag other than submit.
  it('AC-8: true for the native report, false for a report whose reviews lack submit, false for no report', () => {
    expect([
      acceptsReviews(report(NATIVE)),
      acceptsReviews(report(['aggregate', 'invite', 'widget'])),
      acceptsReviews(report([])),
      acceptsReviews(null),
      acceptsReviews(undefined),
    ]).toEqual([true, false, false, false, false])
  })

  it('AC-8: property: over generated reviews capability sets, acceptsReviews is true exactly when the set holds submit', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(REVIEWS_CAPABILITIES), (caps) => {
        expect(acceptsReviews(report(caps)), JSON.stringify(caps)).toBe(caps.includes('submit'))
      }),
      { numRuns: 60 },
    )
  })
})
