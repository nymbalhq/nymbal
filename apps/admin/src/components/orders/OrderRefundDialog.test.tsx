import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMoney } from '@/lib/money'
import { renderWithProviders } from '@/tests/render'
import { orderIn, polyfillRadix } from '@/tests/order-page'
import type { AdminOrder } from '@/types'
import { OrderRefundDialog } from './OrderRefundDialog'

// The refund dialog reads and writes its amount in the order's currency's own digits: a JPY merchant refunding ¥1,200
// types 1200 and sends 1200, a KWD one types 1.250 and sends 1250.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** A paid order in `currency` with 2500 minor units left to refund. */
function paidIn(currency: string): AdminOrder {
  const order = orderIn('confirmed')
  return {
    ...order,
    currency,
    payment: { ...order.payment, currency, refundableMinor: 2500 },
  } as AdminOrder
}

/** The admin API's refund route: records each refund body and answers it succeeded. */
function refundApi(order: AdminOrder) {
  const sent: Array<{ amountMinor: number }> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (
      (init.method ?? 'GET').toUpperCase() === 'POST' &&
      url.pathname === `/api/admin/orders/${order.id}/refund`
    ) {
      sent.push(JSON.parse(String(init.body)) as { amountMinor: number })
      return json({
        data: {
          order,
          payment: order.payment,
          refund: { id: 'r-1', status: 'succeeded', amountMinor: sent.at(-1)?.amountMinor },
        },
      })
    }
    return json({ data: {} })
  })
  return { sent }
}

function renderDialog(order: AdminOrder) {
  const closed = { count: 0 }
  const view = renderWithProviders(
    <OrderRefundDialog order={order} onClose={() => (closed.count += 1)} />,
  )
  return { view, closed }
}

const amountInput = (): HTMLInputElement => screen.getByTestId('admin-order-refund-amount')
const confirmButton = (): HTMLButtonElement => screen.getByTestId('admin-order-refund-confirm')
const refundableShown = (): string | null =>
  screen.getByText('Refundable').nextElementSibling?.textContent ?? null

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the refund amount in the order’s currency', () => {
  // Kills: a prefill or parse over 100 for every currency, so a JPY merchant sees 25.00 and a typed ¥1,200 is sent as
  // 120000.
  it('AC-10: the input opens at the refundable amount in the currency’s digits (JPY 2500, KWD 2.500, GBP 25.00) and a typed amount is sent in minor units (1200 → 1200, 1.250 → 1250, 10.00 → 1000)', async () => {
    const cases = [
      { currency: 'JPY', typed: '1200' },
      { currency: 'KWD', typed: '1.250' },
      { currency: 'GBP', typed: '10.00' },
    ]
    const outcomes = []
    for (const { currency, typed } of cases) {
      const order = paidIn(currency)
      const api = refundApi(order)
      const user = userEvent.setup()
      const { view, closed } = renderDialog(order)

      const prefill = amountInput().value
      const refundable = refundableShown()
      await user.clear(amountInput())
      await user.type(amountInput(), typed)
      // An enabled Refund closes the dialog once answered; a disabled one sends nothing.
      const enabled = !confirmButton().disabled
      await user.click(confirmButton())
      await waitFor(() => expect(closed.count).toBe(enabled ? 1 : 0))

      outcomes.push({
        currency,
        prefill,
        refundable,
        sent: api.sent.map((body) => body.amountMinor),
        closed: closed.count,
      })
      view.unmount()
      vi.unstubAllGlobals()
    }

    expect(outcomes).toEqual([
      {
        currency: 'JPY',
        prefill: '2500',
        refundable: formatMoney(2500, 'JPY'),
        sent: [1200],
        closed: 1,
      },
      {
        currency: 'KWD',
        prefill: '2.500',
        refundable: formatMoney(2500, 'KWD'),
        sent: [1250],
        closed: 1,
      },
      {
        currency: 'GBP',
        prefill: '25.00',
        refundable: formatMoney(2500, 'GBP'),
        sent: [1000],
        closed: 1,
      },
    ])
  })

  it('AC-10: a JPY amount with a fraction (12.5) disables Refund, shows the "Enter an amount" hint, and sends nothing', async () => {
    const order = paidIn('JPY')
    const api = refundApi(order)
    const user = userEvent.setup()
    renderDialog(order)

    await user.clear(amountInput())
    await user.type(amountInput(), '12.5')
    await user.click(confirmButton())

    expect(confirmButton()).toBeDisabled()
    expect(screen.getByText(/^Enter an amount above 0/).textContent).toBe(
      `Enter an amount above 0 and up to ${formatMoney(2500, 'JPY')}.`,
    )
    expect(api.sent).toEqual([])
  })

  it('AC-10: Full refund puts back the refundable amount in the currency’s digits after an edit (JPY 2500, KWD 2.500)', async () => {
    const outcomes = []
    for (const currency of ['JPY', 'KWD']) {
      const order = paidIn(currency)
      refundApi(order)
      const user = userEvent.setup()
      const { view } = renderDialog(order)
      const prefill = amountInput().value

      await user.clear(amountInput())
      await user.type(amountInput(), '1')
      const edited = amountInput().value
      await user.click(screen.getByRole('button', { name: 'Full refund' }))

      outcomes.push({
        currency,
        edited,
        reset: amountInput().value,
        same: amountInput().value === prefill,
      })
      view.unmount()
      vi.unstubAllGlobals()
    }

    expect(outcomes).toEqual([
      { currency: 'JPY', edited: '1', reset: '2500', same: true },
      { currency: 'KWD', edited: '1', reset: '2.500', same: true },
    ])
  })
})
