import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus, PaymentState } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import {
  STATUS_LABEL,
  fakeOrderApi,
  movedTo,
  orderIn,
  polyfillRadix,
  refusal,
  renderOrderPage,
} from '@/tests/order-page'
import { OrderStatusSelect } from './OrderStatusSelect'

// The status select against a fake admin API that refuses every move with 409.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function refusingApi(message: string) {
  const writes: string[] = []
  let answerNow: () => void = () => {}
  const answered = new Promise<void>((resolve) => {
    answerNow = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'POST') {
      writes.push(url.pathname)
      await answered
      return json({ error: { code: 'order.invalid_transition', message } }, 409)
    }
    return json({ data: {} })
  })
  return { writes, answerNow }
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

// Every move the select offers but Shipped, which opens the ship dialog instead of posting.
const MOVES: Array<{
  from: OrderStatus
  capturedMinor: number
  option: string
  action: string
  /** What the select reads while the move is in flight, when the option names a status. */
  inFlightLabel?: string
}> = [
  { from: 'pending', capturedMinor: 0, option: 'record-payment', action: 'mark-paid' },
  { from: 'pending', capturedMinor: 0, option: 'cancelled', action: 'cancel', inFlightLabel: 'Cancelled' },
  { from: 'confirmed', capturedMinor: 2500, option: 'processing', action: 'process', inFlightLabel: 'Processing' },
  { from: 'shipped', capturedMinor: 2500, option: 'delivered', action: 'mark-delivered', inFlightLabel: 'Delivered' },
]

const messageFor = (move: (typeof MOVES)[number]) =>
  `Order NYM-1 cannot move from ${move.from} by ${move.action}`

describe('a status move the server refuses', () => {
  // Kills: the select only logging the refusal, so the merchant sees the select snap back with no reason.
  it('AC-6: while a move is in flight the select reads the chosen status; each move answered 409 shows the answer’s message in admin-order-status-error, and the select shows the current status again', async () => {
    const outcomes: Array<{
      option: string
      inFlight: string | null
      alert: string | null
      shownAgain: boolean
    }> = []
    for (const move of MOVES) {
      const message = messageFor(move)
      const api = refusingApi(message)
      const answerNow = api.answerNow
      const user = userEvent.setup()
      const view = renderWithProviders(
        <OrderStatusSelect
          orderId="o-1"
          currentStatus={move.from}
          orderNumber="NYM-1"
          capturedMinor={move.capturedMinor}
          paymentState="unpaid"
        />,
      )
      const select = screen.getByTestId('admin-order-status-select')
      const shownBefore = select.textContent

      await user.click(select)
      await user.click(await screen.findByTestId(`admin-order-status-option-${move.option}`))

      await waitFor(() => expect(api.writes).toEqual([`/api/admin/orders/o-1/${move.action}`]))
      const shownInFlight = screen.getByTestId('admin-order-status-select').textContent
      answerNow()
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
        inFlight: shownInFlight,
        alert: screen.getByTestId('admin-order-status-error').textContent,
        shownAgain: screen.getByTestId('admin-order-status-select').textContent === shownBefore,
      })
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(outcomes).toEqual(
      MOVES.map((move) => ({
        option: move.option,
        inFlight: expect.stringContaining(move.inFlightLabel ?? ''),
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

function renderSelect(status: OrderStatus, paymentState: PaymentState) {
  return renderWithProviders(
    <OrderStatusSelect
      orderId="o-1"
      currentStatus={status}
      orderNumber="NYM-1001"
      capturedMinor={2500}
      paymentState={paymentState}
    />,
  )
}

const EVERY_STATUS: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]
const EVERY_PAYMENT: PaymentState[] = ['unpaid', 'paid', 'partially_refunded', 'refunded']
const MONEY_LABELS = ['Refunded', 'Partially Refunded']

describe('the select after a successful move', () => {
  // Kills: the optimistic status outliving the move, so the old label stays while the new order's moves are offered.
  it('AC-5: after a successful move to Processing, when currentStatus then becomes Shipped (a change made elsewhere), the select reads Shipped and offers only Shipped’s moves', async () => {
    const steps: OrderStatus[][] = [['shipped'], ['processing', 'shipped']]
    const seen: Array<[string | null, string[] | null]> = []
    for (const statuses of steps) {
      const order = orderIn('confirmed')
      const api = fakeOrderApi(order, () => movedTo(order, 'processing'))
      const user = userEvent.setup()
      const select = (status: OrderStatus) => (
        <OrderStatusSelect
          orderId="o-1"
          currentStatus={status}
          orderNumber="NYM-1001"
          capturedMinor={2500}
          paymentState="paid"
        />
      )
      const view = renderWithProviders(select('confirmed'))

      await user.click(screen.getByTestId('admin-order-status-select'))
      await user.click(await screen.findByTestId(`${OPTION}processing`))
      await waitFor(() => expect(api.answered).toBe(1))
      for (const status of statuses) view.rerender(select(status))

      await waitFor(() =>
        expect(screen.getByTestId('admin-order-status-select')).toHaveTextContent(
          STATUS_LABEL.shipped,
        ),
      )
      const shown = screen.getByTestId('admin-order-status-select').textContent
      const offered = await offeredMoves(user)
      seen.push([shown, offered])
      await user.keyboard('{Escape}')
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual(steps.map(() => [`${STATUS_LABEL.shipped} (current)`, ['delivered']]))
  })
})

describe('the status select follows the fulfilment moves', () => {
  // Kills: the select still narrowing by history, a fully refunded order offered processing or shipped, a paid order
  // offered cancel, or a pick posting the wrong action or twice.
  it('AC-15: a confirmed order offers Processing whether or not partly refunded; a fully refunded confirmed or processing order is the plain label; a fully refunded shipped order offers Delivered; no status ever offers or holds Refunded or Partially Refunded; picking Processing posts one …/process and Delivered one …/mark-delivered', async () => {
    const cells: Array<[OrderStatus, PaymentState, string[] | null, string | null]> = [
      ['confirmed', 'paid', ['processing'], null],
      ['confirmed', 'partially_refunded', ['processing'], null],
      ['processing', 'partially_refunded', ['shipped'], null],
      ['confirmed', 'refunded', null, STATUS_LABEL.confirmed],
      ['processing', 'refunded', null, STATUS_LABEL.processing],
      ['shipped', 'refunded', ['delivered'], null],
      ['delivered', 'refunded', null, STATUS_LABEL.delivered],
    ]
    const seen: unknown[] = []
    for (const [status, payment] of cells) {
      fakeOrderApi(orderIn(status), () => refusal(500, 'test.unexpected', 'no write expected'))
      const user = userEvent.setup()
      const view = renderSelect(status, payment)
      const offered = await offeredMoves(user)
      seen.push([status, payment, offered, offered === null ? view.container.textContent : null])
      await user.keyboard('{Escape}')
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual(cells)

    const heldMoney: unknown[] = []
    for (const status of EVERY_STATUS) {
      for (const payment of EVERY_PAYMENT) {
        fakeOrderApi(orderIn(status), () => refusal(500, 'test.unexpected', 'no write expected'))
        const user = userEvent.setup()
        const view = renderSelect(status, payment)
        const offered = await offeredMoves(user)
        heldMoney.push(
          ...(offered ?? []).filter((o) => o === 'refunded' || o === 'partially_refunded'),
          ...MONEY_LABELS.filter((label) => view.container.textContent === label),
        )
        await user.keyboard('{Escape}')
        view.unmount()
        vi.unstubAllGlobals()
      }
    }
    expect(heldMoney).toEqual([])

    const picks: Array<[OrderStatus, PaymentState, OrderStatus, string]> = [
      ['confirmed', 'partially_refunded', 'processing', 'process'],
      ['shipped', 'refunded', 'delivered', 'mark-delivered'],
    ]
    const posted: unknown[] = []
    for (const [status, payment, pick] of picks) {
      const order = orderIn(status)
      const api = fakeOrderApi(order, () => movedTo(order, pick))
      const user = userEvent.setup()
      const view = renderSelect(status, payment)
      await user.click(await screen.findByTestId('admin-order-status-select'))
      await user.click(await screen.findByTestId(`${OPTION}${pick}`))
      await waitFor(() => expect(api.answered).toBe(1))
      posted.push([status, payment, pick, api.writes.map((w) => w.action)])
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(posted).toEqual(picks.map(([s, p, pick, action]) => [s, p, pick, [action]]))
  })

  // Kills: the order page not handing the payment state to the select, so a fully refunded order offers shipping.
  it('AC-15: on the order page a confirmed order refunded in full keeps the badge Confirmed, reads Refunded in the payment panel and offers no move', async () => {
    const order = orderIn('confirmed', { refundedMinor: 2500 })
    const api = fakeOrderApi(order, () => refusal(500, 'test.unexpected', 'no write expected'))
    const user = userEvent.setup()
    const view = renderOrderPage(order)
    const badge = await screen.findByTestId('admin-order-status-badge', undefined, {
      timeout: 5000,
    })
    expect(badge).toHaveTextContent(STATUS_LABEL.confirmed)
    expect(screen.getByTestId('admin-order-payment-state')).toHaveTextContent('Refunded')
    expect(screen.queryByTestId('admin-order-status-select')).toBeNull()
    expect(await offeredMoves(user)).toBeNull()
    expect(view.container.textContent).toContain(STATUS_LABEL.confirmed)
    expect(api.writes).toEqual([])
  })
})
