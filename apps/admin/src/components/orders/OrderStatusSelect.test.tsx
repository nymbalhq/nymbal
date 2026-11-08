import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import {
  STATUS_LABEL,
  fakeOrderApi,
  movedTo,
  orderIn,
  polyfillRadix,
  refusal,
  renderOrderPage,
  type OrderFixture,
} from '@/tests/order-page'
import { OrderStatusSelect } from './OrderStatusSelect'

// The status select against a fake admin API that refuses every move with 409.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function refusingApi(message: string) {
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'POST') {
      writes.push(url.pathname)
      return json({ error: { code: 'order.invalid_transition', message } }, 409)
    }
    return json({ data: {} })
  })
  return { writes }
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

// Every move the select offers but Shipped, which opens the ship dialog instead of posting.
const MOVES: Array<{ from: OrderStatus; capturedMinor: number; option: string; action: string }> = [
  { from: 'pending', capturedMinor: 0, option: 'record-payment', action: 'mark-paid' },
  { from: 'pending', capturedMinor: 0, option: 'cancelled', action: 'cancel' },
  { from: 'confirmed', capturedMinor: 2500, option: 'processing', action: 'process' },
  { from: 'shipped', capturedMinor: 2500, option: 'delivered', action: 'mark-delivered' },
]

const messageFor = (move: (typeof MOVES)[number]) =>
  `Order NYM-1 cannot move from ${move.from} by ${move.action}`

describe('a status move the server refuses', () => {
  // Kills: the select only logging the refusal, so the merchant sees the select snap back with no reason.
  it('AC-6: each move answered 409 shows the answer’s message in admin-order-status-error, and the select shows the current status again', async () => {
    const outcomes: Array<{ option: string; alert: string | null; shownAgain: boolean }> = []
    for (const move of MOVES) {
      const message = messageFor(move)
      const api = refusingApi(message)
      const user = userEvent.setup()
      const view = renderWithProviders(
        <OrderStatusSelect
          orderId="o-1"
          currentStatus={move.from}
          orderNumber="NYM-1"
          capturedMinor={move.capturedMinor}
        />,
      )
      const select = screen.getByTestId('admin-order-status-select')
      const shownBefore = select.textContent

      await user.click(select)
      await user.click(await screen.findByTestId(`admin-order-status-option-${move.option}`))

      await waitFor(() => expect(api.writes).toEqual([`/api/admin/orders/o-1/${move.action}`]))
      await waitFor(() =>
        expect(screen.getByTestId('admin-order-status-error'), move.option).toHaveTextContent(
          message,
        ),
      )
      expect(screen.getByTestId('admin-order-status-error')).toHaveAttribute('role', 'alert')
      await waitFor(() =>
        expect(screen.getByTestId('admin-order-status-select').textContent, move.option).toBe(
          shownBefore,
        ),
      )
      outcomes.push({
        option: move.option,
        alert: screen.getByTestId('admin-order-status-error').textContent,
        shownAgain: screen.getByTestId('admin-order-status-select').textContent === shownBefore,
      })
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(outcomes).toEqual(
      MOVES.map((move) => ({
        option: move.option,
        alert: expect.stringContaining(messageFor(move)),
        shownAgain: true,
      })),
    )
  })

  // Kills: the select rendering a bare status once the refusal's refetch leaves the order no moves, which drops the
  // message along with it.
  it('AC-6: on the order page, Record payment refused 409 because the order was cancelled elsewhere still shows the answer’s message once the refetch shows the order cancelled', async () => {
    const order = orderIn('pending')
    const message = 'Order NYM-1001 cannot move from cancelled by mark-paid'
    const api = fakeOrderApi(order, () => {
      api.setServer('cancelled')
      return refusal(409, 'order.invalid_transition', message)
    })
    const user = userEvent.setup()
    renderOrderPage(order)

    await user.click(
      await screen.findByTestId('admin-order-status-select', undefined, { timeout: 5000 }),
    )
    await user.click(await screen.findByTestId('admin-order-status-option-record-payment'))

    await waitFor(() => expect(api.answered).toBe(1))
    await waitFor(() =>
      expect(screen.getByTestId('admin-order-status-badge')).toHaveTextContent(
        STATUS_LABEL.cancelled,
      ),
    )
    expect(api.writesTo('mark-paid').length, 'mark-paid POSTs').toBe(1)
    expect(screen.getByTestId('admin-order-status-error')).toHaveTextContent(message)
    expect(screen.getByTestId('admin-order-status-error')).toHaveAttribute('role', 'alert')
  })
})

// A partially refunded order moves on only as the status it was refunded at would; refunds stay with the refund dialog.

type User = ReturnType<typeof userEvent.setup>

const OPTION = 'admin-order-status-option-'
const SHIP_DIALOG = 'admin-order-ship-dialog'
/** The select's own label for a partially refunded order it offers no move for. */
const PLAIN_LABEL = 'Partially Refunded'

/** The moves the select offers (its enabled options), or null when it is the plain label. */
async function offeredMoves(user: User): Promise<string[] | null> {
  const select = screen.queryByTestId('admin-order-status-select')
  if (select === null) return null
  await user.click(select)
  await screen.findByRole('listbox')
  return screen
    .getAllByTestId(new RegExp(`^${OPTION}`))
    .filter((option) => !option.hasAttribute('data-disabled'))
    .map((option) => option.getAttribute('data-testid')!.slice(OPTION.length))
    .sort()
}

function renderPartlyRefunded(refundedAt: OrderStatus | null) {
  return renderWithProviders(
    <OrderStatusSelect
      orderId="o-1"
      currentStatus="partially_refunded"
      orderNumber="NYM-1001"
      capturedMinor={2500}
      statusBeforePartialRefund={refundedAt}
    />,
  )
}

describe('the status select on a partially refunded order', () => {
  // Kills: the select rendering partially_refunded terminal whatever the history says; offering a move the status it
  // was refunded at has already passed (a delivered order shipped again); offering a refund or a cancel.
  it('AC-8: refunded at confirmed it offers exactly Processing, at processing Shipped, at shipped Delivered, at delivered nothing (the plain label), with no history all three; never Refunded, Partially Refunded, Confirmed or Cancelled', async () => {
    const cells: Array<[OrderStatus | null, string[] | null]> = [
      ['confirmed', ['processing']],
      ['processing', ['shipped']],
      ['shipped', ['delivered']],
      ['delivered', null],
      [null, ['delivered', 'processing', 'shipped']],
    ]
    const seen: Array<[OrderStatus | null, string[] | null, string | null]> = []
    for (const [refundedAt] of cells) {
      fakeOrderApi(orderIn('partially_refunded'), () =>
        refusal(500, 'test.unexpected', 'no write expected'),
      )
      const user = userEvent.setup()
      const view = renderPartlyRefunded(refundedAt)
      const offered = await offeredMoves(user)
      seen.push([refundedAt, offered, offered === null ? view.container.textContent : null])
      await user.keyboard('{Escape}')
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual(
      cells.map(([refundedAt, offered]) => [
        refundedAt,
        offered,
        offered === null ? PLAIN_LABEL : null,
      ]),
    )
    const never = ['refunded', 'partially_refunded', 'confirmed', 'cancelled']
    expect(seen.flatMap(([, offered]) => (offered ?? []).filter((s) => never.includes(s)))).toEqual(
      [],
    )
  })

  // Kills: a pick that posts the wrong action, posts twice, or ships without asking for a carrier and tracking number.
  it('AC-8: picking Processing posts one …/process, Delivered one …/mark-delivered, and Shipped opens the ship dialog and posts nothing', async () => {
    const picks: Array<{
      refundedAt: OrderStatus
      pick: OrderStatus
      posts: string[]
      dialog: boolean
    }> = [
      { refundedAt: 'confirmed', pick: 'processing', posts: ['process'], dialog: false },
      { refundedAt: 'shipped', pick: 'delivered', posts: ['mark-delivered'], dialog: false },
      { refundedAt: 'processing', pick: 'shipped', posts: [], dialog: true },
    ]
    const seen: typeof picks = []
    for (const { refundedAt, pick } of picks) {
      const order = orderIn('partially_refunded')
      const api = fakeOrderApi(order, () => movedTo(order, pick))
      const user = userEvent.setup()
      const view = renderPartlyRefunded(refundedAt)
      await user.click(await screen.findByTestId('admin-order-status-select'))
      await user.click(await screen.findByTestId(`${OPTION}${pick}`))
      // Settled: the dialog is open for Shipped, the one write answered for any other pick.
      await waitFor(() =>
        expect(screen.queryByTestId(SHIP_DIALOG) !== null || api.answered === 1).toBe(true),
      )
      seen.push({
        refundedAt,
        pick,
        posts: api.writes.map((w) => w.action),
        dialog: screen.queryByTestId(SHIP_DIALOG) !== null,
      })
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual(picks)
  })

  // Kills: the order page not deriving the refunded-at status from the detail's history, so the select offers every
  // fulfilment move (or none).
  it('AC-8: on the order page, a detail whose history holds processing → partially_refunded offers Shipped and nothing else', async () => {
    const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`
    const row = (
      minute: number,
      fromStatus: OrderStatus | null,
      toStatus: OrderStatus,
      note = '',
    ) => ({
      id: `h-${minute}`,
      orderId: 'o-1',
      fromStatus,
      toStatus,
      actor: 'admin:u-1',
      note,
      timestamp: at(minute),
    })
    const order = {
      ...orderIn('partially_refunded'),
      history: [
        row(0, null, 'pending', 'order draft created'),
        row(1, 'pending', 'confirmed', 'payment captured'),
        row(2, 'confirmed', 'processing'),
        row(3, 'processing', 'partially_refunded', 'refund of £10.00'),
      ],
    } as unknown as OrderFixture
    const api = fakeOrderApi(order, () => refusal(500, 'test.unexpected', 'no write expected'))
    const user = userEvent.setup()
    renderOrderPage(order)
    await screen.findByTestId('admin-order-status-badge', undefined, { timeout: 5000 })

    expect(await offeredMoves(user)).toEqual(['shipped'])
    expect(api.writes).toEqual([])
  })
})
