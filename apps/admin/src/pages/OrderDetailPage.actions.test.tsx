import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import {
  STATUS_LABEL,
  fakeOrderApi,
  held,
  movedTo,
  orderIn,
  polyfillRadix,
  refusal,
  renderOrderPage,
} from '@/tests/order-page'

// The order page's header actions against a fake admin API: what the page says when the server refuses one, and what
// a double click sends.

/** What the API accepts as an Idempotency-Key: 1 to 128 of [A-Za-z0-9._:-]. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const ERROR = 'admin-order-action-error'

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Refused {
  name: string
  from: OrderStatus
  action: string
  /** What the server's copy became before it refused: the status the refetch must show. */
  serverNow: OrderStatus
  message: string
  run: (user: ReturnType<typeof userEvent.setup>) => Promise<void>
}

const primary = (label: string) => async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: label }, { timeout: 5000 }))
}

const REFUSED: Refused[] = [
  {
    name: 'Record payment',
    from: 'pending',
    action: 'mark-paid',
    serverNow: 'cancelled',
    message: 'Order NYM-1001 is cancelled: no payment can be recorded',
    run: primary('Record payment'),
  },
  {
    name: 'Mark Delivered',
    from: 'shipped',
    action: 'mark-delivered',
    serverNow: 'delivered',
    message: 'Order NYM-1001 is already delivered',
    run: primary('Mark Delivered'),
  },
  {
    name: 'Cancel',
    from: 'pending',
    action: 'cancel',
    serverNow: 'confirmed',
    message: 'Order NYM-1001 is paid: refund it instead',
    run: async (user) => {
      await user.click(
        await screen.findByTestId('admin-order-actions', undefined, { timeout: 5000 }),
      )
      await user.click(await screen.findByTestId('admin-order-action-cancel'))
    },
  },
]

describe('an order action the server refuses says why', () => {
  // Kills: `void mutateAsync(…)` dropping the rejection, so nothing is shown; an error path that never refetches,
  // so the badge waits for a realtime event that may never come.
  for (const c of REFUSED) {
    it(`AC-5: ${c.name} answered 409 shows the answer’s message and refetches the order, so the badge shows the server’s status`, async () => {
      const order = orderIn(c.from)
      const api = fakeOrderApi(order, () => {
        api.setServer(c.serverNow)
        return refusal(409, 'order.invalid_transition', c.message)
      })
      const user = userEvent.setup()
      renderOrderPage(order)
      const badge = await screen.findByTestId('admin-order-status-badge', undefined, {
        timeout: 5000,
      })
      expect(badge).toHaveTextContent(STATUS_LABEL[c.from])
      const readsBefore = api.detailReads

      await c.run(user)

      await waitFor(() => expect(api.answered).toBe(1))
      await waitFor(() => expect(screen.getByTestId(ERROR)).toHaveTextContent(c.message))
      expect(screen.getByTestId(ERROR)).toHaveAttribute('role', 'alert')
      expect(api.writesTo(c.action).length, `${c.action} POSTs`).toBe(1)
      await waitFor(() =>
        expect(screen.getByTestId('admin-order-status-badge')).toHaveTextContent(
          STATUS_LABEL[c.serverNow],
        ),
      )
      expect(api.detailReads, 'order detail reads after the refusal').toBeGreaterThan(readsBefore)
    })
  }
})

describe('a primary action submits once per click', () => {
  // Kills: a guard on `isPending` alone (it reaches the button a render late), and a new Idempotency-Key per send.
  const ONCE: Array<{ label: string; from: OrderStatus; action: string; to: OrderStatus }> = [
    { label: 'Record payment', from: 'pending', action: 'mark-paid', to: 'confirmed' },
    { label: 'Mark Delivered', from: 'shipped', action: 'mark-delivered', to: 'delivered' },
  ]
  for (const c of ONCE) {
    it(`AC-7: two clicks on ${c.label} before the page re-renders send one POST, with one key, and the button is disabled while it is in flight`, async () => {
      const order = orderIn(c.from)
      const gate = held(movedTo(order, c.to))
      const api = fakeOrderApi(order, async () => {
        const a = await gate.answer()
        api.setServer(c.to)
        return a
      })
      renderOrderPage(order)
      const button = await screen.findByRole('button', { name: c.label }, { timeout: 5000 })

      act(() => {
        button.click()
        button.click()
      })
      await waitFor(() => expect(api.writesTo(c.action).length).toBeGreaterThan(0))
      const sentInFlight = api.writesTo(c.action).length
      const disabledInFlight = (button as HTMLButtonElement).disabled
      gate.release()
      await waitFor(() => expect(api.answered).toBe(api.writes.length))
      await waitFor(() =>
        expect(screen.getByTestId('admin-order-status-badge')).toHaveTextContent(
          STATUS_LABEL[c.to],
        ),
      )

      const sent = api.writesTo(c.action)
      expect(sentInFlight, `${c.action} POSTs from two clicks`).toBe(1)
      expect(sent.length, `${c.action} POSTs once settled`).toBe(sentInFlight)
      expect(new Set(sent.map((w) => w.key)).size, `keys ${JSON.stringify(sent)}`).toBe(1)
      expect(sent[0]!.key, 'the Idempotency-Key sent').toMatch(KEY_PATTERN)
      expect(disabledInFlight, 'the button while its POST is in flight').toBe(true)
    })
  }
})
