import { act, cleanup, render } from '@testing-library/react'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RecentlyViewed } from '../index.js'

// AC-12's React side: the generated `RecentlyViewed`, exported from `@nymbalhq/react`, sets the element's `current`
// and `limit` attributes from its props (again when they change, as a Next soft navigation between products does) and
// hands `onLoaded` the element's `nymbal:recently-viewed:loaded` event itself.

const TAG = 'nymbal-recently-viewed'

// A stub, so jsdom renders the tag without the element's own behaviour (it would call a client).
if (!customElements.get(TAG)) customElements.define(TAG, class extends HTMLElement {})

const id = fc.stringMatching(/^p-[a-z0-9]{1,8}$/)

describe('AC-12: the RecentlyViewed wrapper', () => {
  it('AC-12: property: it sets current and limit on the one element it renders, follows a new current, and calls onLoaded with each loaded event the element fires', () => {
    fc.assert(
      fc.property(
        id,
        id,
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.array(id, { maxLength: 4 }), { minLength: 1, maxLength: 3 }),
        (first, next, limit, reads) => {
          cleanup()
          const got: Event[] = []
          const onLoaded = (event: Event) => {
            got.push(event)
          }
          const { container, rerender } = render(
            <RecentlyViewed
              current={first}
              limit={limit}
              onLoaded={onLoaded}
              data-testid="recently-viewed"
            />,
          )
          const el = container.querySelector(TAG)
          expect(el?.getAttribute('data-testid')).toBe('recently-viewed')
          expect([el?.getAttribute('current'), el?.getAttribute('limit')]).toEqual([
            first,
            String(limit),
          ])

          rerender(<RecentlyViewed current={next} limit={limit} onLoaded={onLoaded} />)
          expect(container.querySelector(TAG), 'the same element after a new current').toBe(el)
          expect(el?.getAttribute('current')).toBe(next)

          const fired = reads.map(
            (productIds) =>
              new CustomEvent('nymbal:recently-viewed:loaded', {
                detail: { productIds },
                bubbles: true,
                composed: true,
              }),
          )
          act(() => {
            for (const event of fired) el?.dispatchEvent(event)
          })
          expect(got.length).toBe(fired.length)
          got.forEach((event, i) => expect(event).toBe(fired[i]))
        },
      ),
      { numRuns: 25 },
    )
  })
})
