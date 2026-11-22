import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Variant } from '@nymbalhq/types'
import { toMoneyInput } from '@/lib/money'
import { renderWithProviders } from '@/tests/render'
import { polyfillRadix } from '@/tests/order-page'
import { VariantTable } from './VariantTable'

// A variant's price input reads and writes in its currency's own digits, and leaving the field always shows the price
// Save will send: never unparseable text over an older price.

const AT = '2026-10-20T10:00:00.000Z'

function variant(priceMinor: number): Variant {
  return {
    id: 'v-1',
    productId: 'prod-1',
    sku: 'LIN-1',
    name: 'Size 1',
    priceMinor,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: 4,
    lowStockThreshold: 2,
    options: [],
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  }
}

/** The table with one variant at `priceMinor` in `currency`; `price()` is what Save would send now. */
function renderTable(currency: string, priceMinor: number) {
  const sent: Variant[][] = []
  const view = renderWithProviders(
    <VariantTable
      productId="prod-1"
      variants={[variant(priceMinor)]}
      onChange={(variants) => sent.push(variants)}
      currency={currency}
    />,
  )
  const input = (): HTMLInputElement => screen.getByTestId('admin-product-variant-price-v-1')
  const price = (): number | undefined => (sent.at(-1) ?? [variant(priceMinor)])[0]?.priceMinor
  return { view, input, price }
}

type Step = { kind: 'change'; value: string } | { kind: 'keys'; value: string }

/** Runs one edit (one change event, or clear then one key at a time), then blurs; what each step left behind. */
async function edit(currency: string, priceMinor: number, step: Step) {
  const user = userEvent.setup()
  const table = renderTable(currency, priceMinor)
  const shown = table.input().value
  const afterKeys: Array<number | undefined> = []
  if (step.kind === 'change') {
    // Focused first, as a paste is, so the tab below blurs it.
    await user.click(table.input())
    fireEvent.change(table.input(), { target: { value: step.value } })
    afterKeys.push(table.price())
  } else {
    await user.clear(table.input())
    for (const key of step.value) {
      await user.type(table.input(), key)
      afterKeys.push(table.price())
    }
  }
  await user.tab()
  const outcome = { shown, afterKeys, saved: table.price(), afterBlur: table.input().value }
  table.view.unmount()
  return outcome
}

beforeAll(polyfillRadix)

describe('a variant price in its currency’s digits', () => {
  // Kills: the table's own over 100 and times 100, so a JPY price is stored ×100 and shown with two decimals.
  it('AC-11: JPY prices are whole yen: 1500 shows 1500 and 1800 stores 1800; a fraction (18.5) changed in one go keeps 1800, typed key by key stores 1, 18 and stays 18; blur shows the stored price', async () => {
    const outcomes = [
      await edit('JPY', 1500, { kind: 'change', value: '1800' }),
      await edit('JPY', 1800, { kind: 'change', value: '18.5' }),
      await edit('JPY', 1800, { kind: 'keys', value: '18.5' }),
    ]

    expect(outcomes).toEqual([
      { shown: '1500', afterKeys: [1800], saved: 1800, afterBlur: '1800' },
      { shown: '1800', afterKeys: [1800], saved: 1800, afterBlur: '1800' },
      { shown: '1800', afterKeys: [1, 18, 18, 18], saved: 18, afterBlur: '18' },
    ])
  })

  // Kills: blur rewriting only text parseFloat reads, so `1,250.00` or `.5` stays on screen while an older price is
  // what Save sends.
  it('AC-11: a GBP price that is not a plain decimal never stores: 1,250.00 typed key by key stays at the 1.00 its first key made, pasted keeps 15.00, .5 keeps 15.00; 18 stores 1800; blur shows the stored price', async () => {
    const outcomes = [
      await edit('GBP', 1500, { kind: 'keys', value: '1,250.00' }),
      await edit('GBP', 1500, { kind: 'change', value: '1,250.00' }),
      await edit('GBP', 1500, { kind: 'keys', value: '.5' }),
      await edit('GBP', 1500, { kind: 'change', value: '18' }),
    ]

    expect(outcomes).toEqual([
      {
        shown: '15.00',
        afterKeys: [100, 100, 100, 100, 100, 100, 100, 100],
        saved: 100,
        afterBlur: '1.00',
      },
      { shown: '15.00', afterKeys: [1500], saved: 1500, afterBlur: '15.00' },
      { shown: '15.00', afterKeys: [1500, 1500], saved: 1500, afterBlur: '15.00' },
      { shown: '15.00', afterKeys: [1800], saved: 1800, afterBlur: '18.00' },
    ])
    // What the field shows after blur is the input text of the price Save sends, in every case.
    expect(outcomes.map((o) => o.afterBlur)).toEqual(
      outcomes.map((o) => toMoneyInput(o.saved as number, 'GBP')),
    )
  })

  it('AC-11: KWD prices have three decimals: 1500 shows 1.500, 1.75 stores 1750, blur shows 1.750', async () => {
    const outcome = await edit('KWD', 1500, { kind: 'change', value: '1.75' })

    expect(outcome).toEqual({ shown: '1.500', afterKeys: [1750], saved: 1750, afterBlur: '1.750' })
  })

  it('AC-11: a new row’s price reads zero in the currency’s digits (JPY 0, GBP 0.00, KWD 0.000)', async () => {
    const outcomes = []
    for (const currency of ['JPY', 'GBP', 'KWD']) {
      const user = userEvent.setup()
      const sent: Variant[][] = []
      const view = renderWithProviders(
        <VariantTable
          productId="prod-1"
          variants={[]}
          onChange={(v) => sent.push(v)}
          currency={currency}
        />,
      )
      await user.click(screen.getByRole('button', { name: /Add Variant/ }))
      const inputs = screen.getAllByTestId(/^admin-product-variant-price-/) as HTMLInputElement[]
      outcomes.push({
        currency,
        shown: inputs.map((i) => i.value),
        stored: sent.at(-1)?.map((v) => v.priceMinor),
      })
      view.unmount()
    }

    expect(outcomes).toEqual([
      { currency: 'JPY', shown: ['0'], stored: [0] },
      { currency: 'GBP', shown: ['0.00'], stored: [0] },
      { currency: 'KWD', shown: ['0.000'], stored: [0] },
    ])
  })
})
