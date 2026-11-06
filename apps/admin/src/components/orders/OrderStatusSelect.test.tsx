import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import {
  STATUS_LABEL,
  fakeOrderApi,
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
