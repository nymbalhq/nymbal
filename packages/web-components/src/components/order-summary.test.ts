import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatMoney, summaryLines } from '../__fixtures__/server-data.js'

// P2-17 AC-4, the unit half (spec Decision 1 and Invariants): `nymbal-order-summary` renders from its attributes alone,
// so the order page's server render is the summary. Over generated orders that hold the money invariant
// (Σ lineTotalMinor = subtotal; subtotal − discount + shipping + tax = total), each `line` shows its name, its
// quantity and its line total; `totals` shows the subtotal, the shipping (free at 0) and the tax; the `discount` part is
// there exactly when the discount is non-zero (imported `INT-` orders carry one, a checkout order never does, so the
// E2E cannot reach that branch) and shows it; `total` shows the total. Kills: a summary that drops the discount, shows
// it at zero, adds the lines up itself, or puts one amount in another's place.

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

/** The text of each node carrying exactly this part token, in order. */
function partTexts(el: Element, part: string): string[] {
  return [...(el.shadowRoot?.querySelectorAll('[part]') ?? [])]
    .filter((n) => (n.getAttribute('part') ?? '').split(/\s+/).includes(part))
    .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
}

describe('P2-17 AC-4: nymbal-order-summary shows the order’s money', () => {
  it('AC-4: property: one line part per item with its name, qty and line total; totals with subtotal, shipping and tax; a discount part exactly when the discount is non-zero; total equal to subtotal − discount + shipping + tax', async () => {
    await fc.assert(
      fc.asyncProperty(
        summaryLines('o-', 1),
        fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5_000 })),
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        async (items, wanted, shipping, tax) => {
          const subtotal = items.reduce((n, l) => n + l.lineTotalMinor, 0)
          // A discount takes no more than the goods cost.
          const discount = Math.min(wanted, subtotal)
          const total = subtotal - discount + shipping + tax
          const el = await mount({
            items: JSON.stringify(items),
            'subtotal-minor': String(subtotal),
            'discount-minor': String(discount),
            'shipping-minor': String(shipping),
            'tax-minor': String(tax),
            'total-minor': String(total),
            currency: 'GBP',
          })

          const lines = partTexts(el, 'line')
          expect(lines.length).toBe(items.length)
          items.forEach((item, i) => {
            expect(lines[i], `line ${i}`).toContain(item.name)
            expect(lines[i], `line ${i}`).toContain(String(item.qty))
            expect(lines[i], `line ${i}`).toContain(formatMoney(item.lineTotalMinor))
          })

          const totals = partTexts(el, 'totals').join(' ')
          expect(totals).toContain(formatMoney(subtotal))
          expect(totals).toContain(formatMoney(tax))
          expect(
            shipping === 0
              ? totals.includes(formatMoney(0)) || /free/i.test(totals)
              : totals.includes(formatMoney(shipping)),
            `shipping ${shipping} in "${totals}"`,
          ).toBe(true)

          const discountShown: unknown = expect.stringContaining(formatMoney(discount))
          expect(partTexts(el, 'discount'), `discount part for ${discount}`).toEqual(
            discount > 0 ? [discountShown] : [],
          )

          expect(partTexts(el, 'total').join(' ')).toContain(formatMoney(total))
          expect(
            el.shadowRoot?.querySelector('[data-testid="order-summary"]'),
            'data-testid="order-summary" in the element',
          ).not.toBeNull()
        },
      ),
      { numRuns: 40 },
    )
  })
})
