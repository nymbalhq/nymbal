import fc from 'fast-check'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Variant } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { polyfillRadix } from '@/tests/order-page'
import { VariantTable } from './VariantTable'

// A variant's weight in whole grams, on an existing product's rows and a new one's alike: the field reads only digits
// that spell 0 to 1,000,000 (empty is none), keeps the last such value through any other text, and leaving the field
// shows the weight Save will send, never text over an older weight.

const AT = '2026-10-20T10:00:00.000Z'

function weighed(id: string, name: string, weightGrams: number | null): Variant {
  return {
    id,
    productId: 'prod-1',
    sku: `SKU-${id}`,
    name,
    priceMinor: 1500,
    compareAtPriceMinor: null,
    weightGrams,
    dimensions: null,
    stock: 4,
    lowStockThreshold: 2,
    options: [],
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  }
}

const SMALL = weighed('v-small', 'Size 1', 420)
const LARGE = weighed('v-large', 'Size 2', null)

/** The table over `variants`; `weight(id)` is the weight the last onChange handed over for it (as loaded before). */
function renderTable(variants: Variant[], existing: boolean) {
  const sent: Variant[][] = []
  const view = renderWithProviders(
    <VariantTable
      productId="prod-1"
      variants={variants}
      onChange={(next) => sent.push(next)}
      currency="GBP"
      existing={existing}
    />,
  )
  const input = (id: string): HTMLInputElement =>
    screen.getByTestId(`admin-product-variant-weight-${id}`)
  const weight = (id: string): number | null | undefined =>
    (sent.at(-1) ?? variants).find((v) => v.id === id)?.weightGrams
  return { view, sent, input, weight }
}

/** One edit as a paste makes it (focus, one change, blur): what was handed over, and what the field then shows. */
function paste(table: ReturnType<typeof renderTable>, id: string, text: string) {
  fireEvent.focus(table.input(id))
  fireEvent.change(table.input(id), { target: { value: text } })
  const handed = table.weight(id)
  fireEvent.blur(table.input(id))
  return { handed, shown: table.input(id).value }
}

beforeAll(polyfillRadix)

describe('a variant’s weight in grams', () => {
  // Kills: no field, a field that shows 0 for none, a field only new rows have, or one named for no variant.
  it('AC-5: on existing and new rows alike, each variant’s weight field, named "Weight of <name> in grams", shows its grams or is empty for none; a row added with Add Variant is empty', async () => {
    const shown = []
    for (const existing of [true, false]) {
      const table = renderTable([SMALL, LARGE], existing)
      shown.push({
        existing,
        values: [SMALL, LARGE].map((v) => table.input(v.id).value),
        named: [SMALL, LARGE].map(
          (v) =>
            screen.getByRole('textbox', { name: `Weight of ${v.name} in grams` }) ===
            table.input(v.id),
        ),
        inputMode: [SMALL, LARGE].map((v) => table.input(v.id).inputMode),
      })
      table.view.unmount()
    }
    expect(shown).toEqual([
      {
        existing: true,
        values: ['420', ''],
        named: [true, true],
        inputMode: ['numeric', 'numeric'],
      },
      {
        existing: false,
        values: ['420', ''],
        named: [true, true],
        inputMode: ['numeric', 'numeric'],
      },
    ])

    const user = userEvent.setup()
    const table = renderTable([], false)
    await user.click(screen.getByRole('button', { name: /Add Variant/ }))
    const added = screen.getAllByTestId(/^admin-product-variant-weight-/) as HTMLInputElement[]
    expect(added.map((el) => el.value)).toEqual([''])
    expect(table.sent.at(-1)?.map((v) => v.weightGrams)).toEqual([null])
  })

  // Kills: an empty field sent as 0 or kept at the old weight, or a typed weight never handed to the form.
  it('AC-5: typing 250 hands onChange that variant with weightGrams 250 and the other unchanged; emptying it hands null; blur shows 250, then empty', () => {
    const outcomes = []
    for (const existing of [true, false]) {
      const table = renderTable([SMALL, LARGE], existing)
      const set = paste(table, SMALL.id, '250')
      const other = table.weight(LARGE.id)
      const cleared = paste(table, SMALL.id, '')
      outcomes.push({ existing, set, other, cleared })
      table.view.unmount()
    }
    expect(outcomes).toEqual([
      {
        existing: true,
        set: { handed: 250, shown: '250' },
        other: null,
        cleared: { handed: null, shown: '' },
      },
      {
        existing: false,
        set: { handed: 250, shown: '250' },
        other: null,
        cleared: { handed: null, shown: '' },
      },
    ])
  })

  // Kills: parseInt('2.5') storing 2, Number('-1') storing a negative, NaN or an over-large weight handed over, or
  // unreadable text left in the field over the weight Save sends.
  it('AC-5: "2.5", "-1", "abc" and "1000001" each leave the last weight (250) in what onChange last handed over, and after a blur the field shows 250', () => {
    const outcomes = []
    for (const text of ['2.5', '-1', 'abc', '1000001']) {
      const table = renderTable([SMALL, LARGE], true)
      expect(paste(table, SMALL.id, '250'), 'the weight before').toEqual({
        handed: 250,
        shown: '250',
      })
      outcomes.push({ text, ...paste(table, SMALL.id, text) })
      table.view.unmount()
    }
    expect(outcomes).toEqual(
      ['2.5', '-1', 'abc', '1000001'].map((text) => ({ text, handed: 250, shown: '250' })),
    )
  })

  // Kills: a bound off by one, leading zeros read as anything but the number, or a long string read past the bound.
  it('AC-5: property: over digit strings, the weight handed over is the number the digits spell when it is 0 to 1,000,000, else the last weight; after a blur the field shows the weight handed over', () => {
    const table = renderTable([SMALL, LARGE], true)
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{1,10}$/), (digits) => {
        expect(paste(table, SMALL.id, '100'), 'the weight before').toEqual({
          handed: 100,
          shown: '100',
        })
        const spelled = Number(digits)
        const expected = spelled <= 1_000_000 ? spelled : 100
        expect(paste(table, SMALL.id, digits), digits).toEqual({
          handed: expected,
          shown: String(expected),
        })
      }),
      {
        numRuns: 60,
        examples: [
          ['0'],
          ['000'],
          ['007'],
          ['1000000'],
          ['1000001'],
          ['0001000000'],
          ['999999999'],
        ],
      },
    )
    table.view.unmount()
  })
})
