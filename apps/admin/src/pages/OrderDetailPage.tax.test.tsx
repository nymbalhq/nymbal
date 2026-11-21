import { screen } from '@testing-library/react'
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMoney } from '@/lib/money'
import { fakeOrderApi, orderIn, polyfillRadix, renderOrderPage } from '@/tests/order-page'

// The order page's totals for an order whose prices include tax and for one whose tax was added on top, against a
// fake admin API: the merchant reads which it is from the tax row's label, beside the tax the order recorded.

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The order page's tax row for an order of this tax and flag: its label and the amount beside it. */
async function taxRowOf(taxTotalMinor: number, pricesIncludeTax: boolean) {
  const base = orderIn('confirmed')
  const order = Object.assign(base, {
    taxTotalMinor,
    totalMinor: pricesIncludeTax ? base.subtotalMinor : base.subtotalMinor + taxTotalMinor,
    pricesIncludeTax,
  })
  fakeOrderApi(order, () => ({ status: 500, body: {} }))
  const view = renderOrderPage(order)
  await screen.findByTestId('admin-order-status-badge', undefined, { timeout: 5000 })
  const label = screen.getByText(/^Tax( \(included\))?$/)
  const row = {
    label: label.textContent,
    amount: label.parentElement?.querySelectorAll('span')[1]?.textContent ?? null,
  }
  view.unmount()
  vi.unstubAllGlobals()
  return row
}

describe('AC-21: the admin order page’s tax row', () => {
  // Kills: the merchant reading an inclusive order's total as short by its tax.
  it('AC-21: property: an inclusive order’s tax is labelled "Tax (included)" and an exclusive one’s "Tax", each beside the order’s tax', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 99_999 }),
        fc.boolean(),
        async (tax, inclusive) => {
          expect(await taxRowOf(tax, inclusive)).toEqual({
            label: inclusive ? 'Tax (included)' : 'Tax',
            amount: formatMoney(tax, 'GBP'),
          })
        },
      ),
      { numRuns: 6 },
    )
  })
})
