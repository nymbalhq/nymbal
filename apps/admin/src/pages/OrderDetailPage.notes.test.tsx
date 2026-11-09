import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeOrderApi, orderIn, polyfillRadix, refusal, renderOrderPage } from '@/tests/order-page'

// The order page against a fake admin API: the Order Note panel over each shape of the order's `notes` column, and
// an order's lines where imported lines share a variant id.

const SHOPPER = 'Leave it with the neighbour at number 3'
const REFUSAL =
  'Tracking was not registered with test-ship: unknown. Carrier updates will not arrive.'
const AT = '2026-11-01T10:00:00.000Z'

const entry = (body: string, actor: string) => ({ body, actor, at: AT })
const unwritten = () => refusal(500, 'test.unexpected', 'no write expected')

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const PANEL = 'Order Note'

async function panelOf(notes: string) {
  const order = { ...orderIn('shipped'), notes }
  fakeOrderApi(order, unwritten)
  const view = renderOrderPage(order)
  await screen.findByTestId('admin-order-status-badge', undefined, { timeout: 5000 })
  const heading = screen.queryByText(PANEL)
  const seen = {
    panel: heading === null ? null : heading.parentElement!.querySelector('p')!.textContent,
    hasJson: /"actor"|\[\{/.test(view.container.textContent ?? ''),
  }
  view.unmount()
  vi.unstubAllGlobals()
  return seen
}

describe('the Order Note panel', () => {
  it('AC-18: notes holding a shopper’s entry and a refusal show the shopper’s words and no JSON; only system or admin entries show no panel; a plain string shows the string', async () => {
    const withShopper = JSON.stringify([entry(SHOPPER, 'customer'), entry(REFUSAL, 'system')])
    const systemOnly = JSON.stringify([entry(REFUSAL, 'system')])
    const adminOnly = JSON.stringify([entry('Called the buyer', 'admin:u-1')])

    const cells: Array<[string, { panel: string | null; hasJson: boolean }]> = [
      [withShopper, { panel: SHOPPER, hasJson: false }],
      [systemOnly, { panel: null, hasJson: false }],
      [adminOnly, { panel: null, hasJson: false }],
      [SHOPPER, { panel: SHOPPER, hasJson: false }],
    ]

    const seen: unknown[] = []
    for (const [notes] of cells) seen.push(await panelOf(notes))

    expect(seen).toEqual(cells.map(([, expected]) => expected))
  }, 30_000)
})

describe('an order’s lines', () => {
  it('AC-17: an order with two lines of variantId unknown renders both, and React reports no duplicate key', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const order = orderIn('shipped')
    const [line] = order.lineItems
    const shared = { ...line!, variantId: 'unknown' }
    const twoLines = {
      ...order,
      lineItems: [
        { ...shared, productName: 'First import' },
        { ...shared, productName: 'Second import' },
      ],
    }
    fakeOrderApi(twoLines, unwritten)

    renderOrderPage(twoLines)
    await screen.findByTestId('admin-order-status-badge', undefined, { timeout: 5000 })

    await waitFor(() =>
      expect(screen.getAllByText(/import$/).map((n) => n.textContent)).toEqual([
        'First import',
        'Second import',
      ]),
    )
    const keyWarnings = consoleError.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((text) => text.includes('same key'))
    expect(keyWarnings).toEqual([])
  })
})
