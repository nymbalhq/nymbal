import fc from 'fast-check'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OrderTimelineEntry, ShopperOrder } from '@nymbalhq/types'
import { ORDER_TIMELINE_KINDS } from '@nymbalhq/types'
import { OrderView } from '@/app/(shopper)/order/[orderNumber]/OrderView'

// The guest order page as the server renders it. The timeline element renders nothing for no entries, so a host
// rendered anyway is an empty block with a margin above the summary.

const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  city: 'London',
  region: 'Greater London',
  postalCode: 'N1 1AA',
  country: 'GB',
}

function orderWith(timeline: OrderTimelineEntry[] | undefined): ShopperOrder {
  return {
    orderNumber: 'NYM-1001',
    status: 'confirmed',
    shippingAddress: ADDRESS,
    lineItems: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productName: 'Mug',
        variantName: 'Blue',
        sku: 'MUG-BLUE',
        qty: 1,
        unitPriceMinor: 1200,
        lineSubtotalMinor: 1200,
        lineTaxMinor: 0,
        lineTotalMinor: 1200,
        imageUrl: '',
      },
    ],
    subtotalMinor: 1200,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1200,
    currency: 'GBP',
    createdAt: '2026-11-01T10:00:00.000Z',
    ...(timeline !== undefined && { timeline }),
  }
}

/** How many timeline elements the server HTML holds. */
function timelinesIn(html: string): number {
  return html.match(/<nymbal-order-timeline[\s>]/g)?.length ?? 0
}

const anEntry: fc.Arbitrary<OrderTimelineEntry> = fc.record({
  kind: fc.constantFrom(...ORDER_TIMELINE_KINDS),
  at: fc
    .date({
      min: new Date('2020-01-01T00:00:00Z'),
      max: new Date('2030-01-01T00:00:00Z'),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString()),
})

describe('the guest order page renders the timeline only when the order has an entry', () => {
  it('AC-6: an order whose timeline is [] or absent renders no nymbal-order-timeline', () => {
    const counts = [[], undefined].map((timeline) =>
      timelinesIn(renderToStaticMarkup(<OrderView order={orderWith(timeline)} />)),
    )
    expect(counts).toEqual([0, 0])
  })

  it('AC-6: property: an order with one or more entries renders exactly one nymbal-order-timeline, and one fewer when its entries are taken away', () => {
    fc.assert(
      fc.property(fc.array(anEntry, { minLength: 1, maxLength: 7 }), (entries) => {
        const withEntries = timelinesIn(
          renderToStaticMarkup(<OrderView order={orderWith(entries)} />),
        )
        const without = timelinesIn(renderToStaticMarkup(<OrderView order={orderWith([])} />))
        expect(withEntries).toBe(1)
        expect(without).toBe(withEntries - 1)
      }),
      { numRuns: 20 },
    )
  })
})
