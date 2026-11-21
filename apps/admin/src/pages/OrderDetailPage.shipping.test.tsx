import { screen } from '@testing-library/react'
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMoney } from '@/lib/money'
import { fakeOrderApi, orderIn, polyfillRadix, renderOrderPage } from '@/tests/order-page'

// The order page's shipping row against a fake admin API: an order that records the delivery the shopper chose names
// it, at any amount, so the merchant ships what was paid for; an order from a store with no shipping table shows the
// row as before.

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Recorded {
  optionId: string
  name: string
  amountMinor: number
}

/** The order page's shipping row for an order with this shipping, recorded in metadata or not: label and amount. */
async function shippingRowOf(shippingTotalMinor: number, recorded: Recorded | null) {
  const base = orderIn('confirmed')
  const order = Object.assign(base, {
    shippingTotalMinor,
    totalMinor: base.subtotalMinor + shippingTotalMinor,
    metadata: {
      ...((base as { metadata?: Record<string, unknown> }).metadata ?? {}),
      ...(recorded !== null && {
        shipping: { provider: 'native', estimatedDays: null, ...recorded },
      }),
    },
  })
  fakeOrderApi(order, () => ({ status: 500, body: {} }))
  const view = renderOrderPage(order)
  await screen.findByTestId('admin-order-status-badge', undefined, { timeout: 5000 })
  // The totals' row, beside its amount: the page has a "Shipping" heading for the address too.
  const label =
    screen
      .queryAllByText(/^Shipping( \(.+\))?$/)
      .find((el) => (el.parentElement?.querySelectorAll('span').length ?? 0) >= 2) ?? null
  const row =
    label === null
      ? null
      : {
          label: label.textContent,
          amount: label.parentElement?.querySelectorAll('span')[1]?.textContent ?? null,
        }
  view.unmount()
  vi.unstubAllGlobals()
  return row
}

const arbName = fc.constantFrom('Standard', 'Express', 'Next day', 'Click and collect')

describe('AC-24: the admin order page names the delivery paid for', () => {
  // Kills: an Express order shown as plain "Shipping", so the merchant ships it as Standard; a free option's row hidden,
  // so the merchant cannot see which free delivery was chosen; or an order from a store with no table relabelled.
  it('AC-24: property: an order with metadata.shipping shows "Shipping (<name>)" beside its shipping amount, also at 0; the same order without it shows "Shipping" above 0 and no row at 0, as before', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 99_999 })),
        arbName,
        async (amount, name) => {
          const named = await shippingRowOf(amount, { optionId: 'opt', name, amountMinor: amount })
          const bare = await shippingRowOf(amount, null)

          expect(named).toEqual({ label: `Shipping (${name})`, amount: formatMoney(amount, 'GBP') })
          expect(bare).toEqual(
            amount > 0 ? { label: 'Shipping', amount: formatMoney(amount, 'GBP') } : null,
          )
        },
      ),
      { numRuns: 8 },
    )
  })
})
