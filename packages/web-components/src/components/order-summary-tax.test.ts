import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatMoney, summaryLines } from '../__fixtures__/server-data.js'

// `nymbal-order-summary` on an order whose prices include tax: the tax row says the tax is included, and the total is
// the order's total as given, with the tax not added to it a second time. Without the attribute the row reads "Tax".

const TAG = 'nymbal-order-summary'

async function mount(attributes: Record<string, string>): Promise<HTMLElement> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  document.body.append(el)
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
  return el
}

const text = (node: Element | null | undefined): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The tax row's label and amount, and the total part's text. */
function shown(el: HTMLElement) {
  const tax = el.shadowRoot?.querySelector('[part~="tax"]')
  return {
    label: text(tax?.querySelector('dt')),
    amount: text(tax?.querySelector('dd')),
    total: text(el.shadowRoot?.querySelector('[part~="total"]')),
  }
}

describe('AC-20: nymbal-order-summary on an order whose prices include tax', () => {
  // Kills: an inclusive receipt reading as tax added on top of its total.
  it('AC-20: property: with prices-include-tax the tax row is labelled "Tax (included)" with the tax, and the total is total-minor, which already holds it; without the attribute the label is "Tax"', async () => {
    await fc.assert(
      fc.asyncProperty(
        summaryLines('t-', 1),
        fc.integer({ min: 1, max: 5_000 }),
        fc.boolean(),
        async (items, taxMinor, inclusive) => {
          const subtotal = items.reduce((n, l) => n + l.lineTotalMinor, 0)
          // An inclusive order's total is its subtotal; an exclusive one adds the tax.
          const total = inclusive ? subtotal : subtotal + taxMinor
          const el = await mount({
            items: JSON.stringify(items),
            'subtotal-minor': String(subtotal),
            'discount-minor': '0',
            'shipping-minor': '0',
            'tax-minor': String(taxMinor),
            'total-minor': String(total),
            currency: 'GBP',
            ...(inclusive && { 'prices-include-tax': '' }),
          })

          expect(shown(el)).toEqual({
            label: inclusive ? 'Tax (included)' : 'Tax',
            amount: formatMoney(taxMinor),
            total: `Total ${formatMoney(total)}`,
          })
        },
      ),
      { numRuns: 25 },
    )
  })

  it('AC-20: the pricesIncludeTax property relabels the row as the attribute does, and unsetting it restores "Tax"', async () => {
    const el = await mount({
      items: JSON.stringify([{ name: 'Mug', qty: 2, unitPriceMinor: 600, lineTotalMinor: 1200 }]),
      'subtotal-minor': '1200',
      'tax-minor': '200',
      'total-minor': '1200',
      currency: 'GBP',
    })
    const element = el as HTMLElement & {
      pricesIncludeTax: boolean
      updateComplete: Promise<unknown>
    }
    const before = shown(el).label

    element.pricesIncludeTax = true
    await element.updateComplete
    const included = shown(el).label
    element.pricesIncludeTax = false
    await element.updateComplete

    expect([before, included, shown(el).label]).toEqual(['Tax', 'Tax (included)', 'Tax'])
  })
})
