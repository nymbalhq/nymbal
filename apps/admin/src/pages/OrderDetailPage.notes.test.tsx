import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  fakeOrderApi,
  orderIn,
  polyfillRadix,
  refusal,
  renderOrderPage,
  STATUS_LABEL,
} from '@/tests/order-page'

// The order page against a fake admin API: the Order Note panel over each shape of shopper text in the order's `notes`
// column, beside the Notes tab the notes route feeds, and an order's lines where imported lines share a variant id.

const SHOPPER = 'Leave it with the neighbour at number 3'
const AT = '2026-11-01T10:00:00.000Z'

const unwritten = () => refusal(500, 'test.unexpected', 'no write expected')

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const PANEL = 'Order Note'
const BADGE = 'admin-order-status-badge'
const NOTES_TAB = 'admin-order-notes'
const EMPTY = 'No notes yet.'

/** The text of each paragraph in the Notes tab: one per listed note, or the empty state. */
function listedNotes(): string[] {
  const tab = screen.queryByTestId(NOTES_TAB)
  return tab === null ? [] : [...tab.querySelectorAll('p')].map((p) => p.textContent ?? '')
}

/** The page for an order placed with `notes`, the notes route answering it as the customer's one entry. */
async function pageOf(notes: string) {
  const order = { ...orderIn('shipped'), notes }
  fakeOrderApi(order, unwritten, {
    notes: [{ body: notes, actor: 'customer', at: order.createdAt }],
  })
  const view = renderOrderPage(order)
  const badge = await screen
    .findByTestId(BADGE, undefined, { timeout: 5000 })
    .then((node) => node.textContent)
    .catch(() => null)
  const listed = await waitFor(() => {
    const seen = listedNotes()
    if (seen.length === 0 || seen[0] === EMPTY) throw new Error('the notes have not loaded')
    return seen
  }).catch(() => listedNotes())
  const heading = screen.queryByText(PANEL)
  const seen = {
    badge,
    panel: heading === null ? null : heading.parentElement!.querySelector('p')!.textContent,
    listed,
  }
  view.unmount()
  vi.unstubAllGlobals()
  return seen
}

describe('the Order Note panel', () => {
  it('AC-3: whatever text the shopper placed the order with, JSON or plain, the Order Note panel holds exactly that text, the status badge renders, and the Notes tab lists the one customer note', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cases = [
      '[null]',
      '[]',
      '[{"actor":"customer","body":{"a":1}}]',
      JSON.stringify([
        { body: 'Refund agreed', actor: 'admin:u-1', at: AT },
        { body: SHOPPER, actor: 'customer', at: AT },
        { body: 'Tracking was not registered', actor: 'system', at: AT },
      ]),
      SHOPPER,
    ]

    const seen: unknown[] = []
    for (const notes of cases) seen.push(await pageOf(notes))

    expect(seen).toEqual(
      cases.map((notes) => ({ badge: STATUS_LABEL.shipped, panel: notes, listed: [notes] })),
    )
  }, 60_000)
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
