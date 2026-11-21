import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import {
  held,
  orderIn,
  polyfillRadix,
  refusal,
  type Answer,
  type OrderFixture,
} from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { OrdersListPage } from './OrdersListPage'

// The order list's actions against a fake admin API (fetch stubbed): a list that answers each filter from the
// server's copy, every write recorded by path, and answers a test may hold back. A move the API accepts changes the
// server's copy, so the list reads what the run left behind.

type Row = Omit<OrderFixture, 'payment'> & { payment?: OrderFixture['payment'] }
type User = ReturnType<typeof userEvent.setup>

const NEXT: Record<string, OrderStatus> = { cancel: 'cancelled', process: 'processing' }
const id = (orderNumber: string) => orderNumber.toLowerCase()
const route = (orderNumber: string, action: string) =>
  `/api/admin/orders/${id(orderNumber)}/${action}`

/** An order read in `status`: paid unless pending or cancelled, as `orderIn` makes it. */
const rowIn = (status: OrderStatus, orderNumber: string): Row =>
  orderIn(status, { id: id(orderNumber), orderNumber })

const unpaid = (status: OrderStatus, orderNumber: string): Row => {
  const row = rowIn(status, orderNumber)
  return {
    ...row,
    capturedMinor: 0,
    capturedAt: null,
    captureMethod: null,
    payment: {
      state: 'unpaid',
      capturedMinor: 0,
      refundedMinor: 0,
      refundableMinor: 0,
      currency: 'GBP',
      refunds: [],
    },
  }
}

const accepted: Answer = { status: 200, body: { data: {} } }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function fakeListApi(
  rows: Row[],
  answer: (path: string) => Answer | Promise<Answer> = () => accepted,
) {
  const server = new Map(rows.map((r) => [r.id, r]))
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
      const a = await answer(url.pathname)
      if (a.status < 300) {
        const [orderId, action] = url.pathname.split('/').slice(-2) as [string, string]
        const row = server.get(orderId)!
        server.set(orderId, { ...row, status: NEXT[action] ?? row.status })
      }
      return json(a.body, a.status)
    }
    if (url.pathname !== '/api/admin/orders') return json({ data: {} })
    const status = url.searchParams.get('status')
    const data = [...server.values()].filter((r) => status === null || r.status === status)
    return json({ data, meta: { total: data.length } })
  })
  return { writes }
}

const numbersIn = (el: HTMLElement) => (el.textContent?.match(/\d+/g) ?? []).map(Number)

const countOf = () => numbersIn(screen.getByTestId('admin-orders-bulk-count'))[0]

const checkbox = (orderNumber: string) =>
  screen.getByRole('checkbox', { name: `Select order ${orderNumber}` })

async function select(user: User, orderNumbers: string[]) {
  await screen.findByTestId(`admin-orders-row-${orderNumbers[0]}`)
  for (const n of orderNumbers) await user.click(checkbox(n))
}

async function press(user: User, action: 'process' | 'cancel') {
  await user.click(await screen.findByTestId(`admin-orders-bulk-${action}`))
  return screen.findByTestId('admin-orders-bulk-dialog')
}

async function submit(user: User) {
  await user.click(await screen.findByTestId('admin-orders-bulk-submit'))
}

async function dismiss(user: User) {
  await user.click(await screen.findByTestId('admin-orders-bulk-dismiss'))
  await waitFor(() => expect(screen.queryByTestId('admin-orders-bulk-dialog')).toBeNull())
}

/** Every number the merchant is told is among the numbers shown in `el`. */
function expectCounts(el: HTMLElement, counts: number[]) {
  expect(numbersIn(el)).toEqual(expect.arrayContaining(counts))
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the admin order list’s bulk actions', () => {
  it('AC-7: a selected row the status filter hides leaves the bar’s count, and a submit sends nothing for it', async () => {
    const { writes } = fakeListApi([unpaid('confirmed', 'NYM-HIDDEN'), rowIn('pending', 'NYM-SHOWN')])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-HIDDEN', 'NYM-SHOWN'])
    const before = countOf()!

    await user.click(screen.getByRole('button', { name: 'Pending' }))
    await waitFor(() => expect(screen.queryByTestId('admin-orders-row-NYM-HIDDEN')).toBeNull())
    await screen.findByTestId('admin-orders-row-NYM-SHOWN')
    await waitFor(() => expect(countOf()).toBe(before - 1))

    await press(user, 'cancel')
    await submit(user)
    await screen.findByTestId('admin-orders-bulk-result')
    expect(writes).toEqual([route('NYM-SHOWN', 'cancel')])
  })

  it('AC-7: the header checkbox reads only the rows shown: one deselected reads unchecked, and with a hidden row selected Select all still selects every row shown', async () => {
    fakeListApi([
      rowIn('pending', 'NYM-ONE'),
      rowIn('pending', 'NYM-TWO'),
      unpaid('confirmed', 'NYM-THREE'),
    ])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await screen.findByTestId('admin-orders-row-NYM-ONE')
    const header = () => screen.getByRole('checkbox', { name: 'Select all' })

    await user.click(header())
    expect(header()).toBeChecked()
    await user.click(checkbox('NYM-TWO'))
    expect(header()).not.toBeChecked()

    await user.click(checkbox('NYM-ONE'))
    await user.click(screen.getByRole('button', { name: 'Pending' }))
    await waitFor(() => expect(screen.queryByTestId('admin-orders-row-NYM-THREE')).toBeNull())
    await user.click(checkbox('NYM-ONE'))
    // NYM-THREE, hidden, and NYM-ONE are two selected; two rows are shown, one of them selected.
    expect(header()).not.toBeChecked()

    await user.click(header())
    expect(checkbox('NYM-ONE')).toBeChecked()
    expect(checkbox('NYM-TWO')).toBeChecked()
    expect(countOf()).toBe(2)
  })

  it('AC-8: the bar’s actions are exactly Mark processing and Cancel, no Confirm All or Filter is on the page, and each action opens the dialog', async () => {
    const { writes } = fakeListApi([rowIn('confirmed', 'NYM-ONE')])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-ONE'])

    const bar = await screen.findByTestId('admin-orders-bulk-bar')
    const actions = within(bar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'))
      .sort()
    expect(actions).toEqual(['admin-orders-bulk-cancel', 'admin-orders-bulk-process'])
    expect(screen.queryByRole('button', { name: /confirm all/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^filter$/i })).toBeNull()

    for (const action of ['process', 'cancel'] as const) {
      await press(user, action)
      await dismiss(user)
    }
    expect(writes).toEqual([])
  })

  it('AC-9: Mark processing on a confirmed, a pending and a fully refunded confirmed order sends one POST …/process for the first and no POST …/confirm, and lists the other two with their reasons', async () => {
    const { writes } = fakeListApi([
      rowIn('confirmed', 'NYM-MOVE'),
      rowIn('pending', 'NYM-WAIT'),
      orderIn('confirmed', { id: 'nym-back', orderNumber: 'NYM-BACK', refundedMinor: 2500 }),
    ])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-MOVE', 'NYM-WAIT', 'NYM-BACK'])

    await press(user, 'process')
    expect(numbersIn(screen.getByTestId('admin-orders-bulk-summary'))).toEqual([1, 2])
    expect(screen.getByTestId('admin-orders-bulk-skipped-NYM-WAIT')).toHaveTextContent(
      /pending|status/i,
    )
    expect(screen.getByTestId('admin-orders-bulk-skipped-NYM-BACK')).toHaveTextContent(/refund/i)
    expect(screen.queryByTestId('admin-orders-bulk-skipped-NYM-MOVE')).toBeNull()

    await submit(user)
    await screen.findByTestId('admin-orders-bulk-result')
    expect(writes).toEqual([route('NYM-MOVE', 'process')])
  })

  it('AC-10: Cancel on an unpaid pending, a paid confirmed and a shipped unpaid order sends one POST …/cancel and lists the other two as paid and status', async () => {
    const { writes } = fakeListApi([
      rowIn('pending', 'NYM-OPEN'),
      rowIn('confirmed', 'NYM-PAID'),
      unpaid('shipped', 'NYM-SENT'),
    ])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-OPEN', 'NYM-PAID', 'NYM-SENT'])

    await press(user, 'cancel')
    expect(numbersIn(screen.getByTestId('admin-orders-bulk-summary'))).toEqual([1, 2])
    expect(screen.getByTestId('admin-orders-bulk-skipped-NYM-PAID')).toHaveTextContent(
      /paid|refund/i,
    )
    expect(screen.getByTestId('admin-orders-bulk-skipped-NYM-SENT')).toHaveTextContent(
      /shipped|status/i,
    )
    expect(screen.queryByTestId('admin-orders-bulk-skipped-NYM-OPEN')).toBeNull()

    await submit(user)
    await screen.findByTestId('admin-orders-bulk-result')
    expect(writes).toEqual([route('NYM-OPEN', 'cancel')])
  })

  it('AC-10: with nothing eligible Submit is disabled and pressing it sends nothing', async () => {
    const { writes } = fakeListApi([rowIn('confirmed', 'NYM-PAID'), unpaid('delivered', 'NYM-DONE')])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-PAID', 'NYM-DONE'])

    await press(user, 'cancel')
    const send = screen.getByTestId('admin-orders-bulk-submit')
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(writes).toEqual([])
  })

  it('AC-11: one success and one refusal read one changed and one not, the failure shows the server’s message, and on dismiss the refused order stays selected and the succeeded one does not', async () => {
    const message = 'Order NYM-REFUSED is paid: refund it instead'
    const { writes } = fakeListApi(
      [rowIn('pending', 'NYM-DONE'), rowIn('pending', 'NYM-REFUSED')],
      (path) => (path === route('NYM-REFUSED', 'cancel') ? refusal(409, 'order.paid', message) : accepted),
    )
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-DONE', 'NYM-REFUSED'])

    await press(user, 'cancel')
    await submit(user)
    const result = await screen.findByTestId('admin-orders-bulk-result')

    expect(numbersIn(result).filter((n) => n === 1)).toHaveLength(2)
    expect(screen.getByTestId('admin-orders-bulk-failed-NYM-REFUSED')).toHaveTextContent(message)
    expect(screen.queryByTestId('admin-orders-bulk-failed-NYM-DONE')).toBeNull()
    expect(writes).toEqual([route('NYM-DONE', 'cancel'), route('NYM-REFUSED', 'cancel')])

    await dismiss(user)
    await waitFor(() => expect(checkbox('NYM-REFUSED')).toBeChecked())
    expect(checkbox('NYM-DONE')).not.toBeChecked()
    expect(countOf()).toBe(1)
  })

  it('AC-12: mid-run Escape, the overlay and dismiss do nothing, the progress counts done of total and Submit is disabled; on the result view Submit sends nothing more', async () => {
    const first = held(accepted)
    const second = held(accepted)
    const { writes } = fakeListApi(
      [rowIn('pending', 'NYM-ONE'), rowIn('pending', 'NYM-TWO')],
      (path) => (path === route('NYM-ONE', 'cancel') ? first.answer() : second.answer()),
    )
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-ONE', 'NYM-TWO'])
    await press(user, 'cancel')
    await submit(user)

    const progress = await screen.findByTestId('admin-orders-bulk-progress')
    await waitFor(() => expect(numbersIn(progress)).toEqual([0, 2]))
    expect(screen.getByTestId('admin-orders-bulk-submit')).toBeDisabled()

    await user.keyboard('{Escape}')
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    const dismissButton = screen.queryByTestId('admin-orders-bulk-dismiss')
    if (dismissButton !== null) fireEvent.click(dismissButton)
    expect(screen.getByTestId('admin-orders-bulk-dialog')).toBeInTheDocument()

    first.release()
    await waitFor(() =>
      expect(numbersIn(screen.getByTestId('admin-orders-bulk-progress'))).toEqual([1, 2]),
    )
    second.release()
    await screen.findByTestId('admin-orders-bulk-result')

    const sent = writes.length
    const again = screen.queryByTestId<HTMLButtonElement>('admin-orders-bulk-submit')
    expect(again === null || again.disabled, 'Submit absent or disabled').toBe(true)
    if (again !== null) fireEvent.click(again)
    expect(writes.length).toBe(sent)
    expect(sent).toBe(2)
  })

  it('AC-13: a row’s Cancel order opens the dialog for that order alone and its Submit sends one POST …/cancel', async () => {
    const { writes } = fakeListApi([rowIn('pending', 'NYM-ROW'), rowIn('pending', 'NYM-OTHER')])
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await select(user, ['NYM-OTHER'])

    await user.click(screen.getByRole('button', { name: 'Actions for order NYM-ROW' }))
    await user.click(await screen.findByTestId('admin-orders-row-cancel-NYM-ROW'))
    await screen.findByTestId('admin-orders-bulk-dialog')
    expectCounts(screen.getByTestId('admin-orders-bulk-summary'), [1])

    await submit(user)
    await screen.findByTestId('admin-orders-bulk-result')
    expect(writes).toEqual([route('NYM-ROW', 'cancel')])
  })

  it('AC-13: a row planOrderBulk would refuse (paid by its stored amounts with no payment read, already cancelled, shipped) has its Cancel order disabled and it sends nothing', async () => {
    const { payment: _payment, ...placedByRealtime } = rowIn('confirmed', 'NYM-LIVE')
    const rows: Row[] = [
      placedByRealtime,
      rowIn('cancelled', 'NYM-GONE'),
      unpaid('shipped', 'NYM-SENT'),
    ]
    const { writes } = fakeListApi(rows)
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await screen.findByTestId('admin-orders-row-NYM-LIVE')

    for (const { orderNumber } of rows) {
      await user.click(screen.getByRole('button', { name: `Actions for order ${orderNumber}` }))
      const item = await screen.findByTestId(`admin-orders-row-cancel-${orderNumber}`)
      expect(item).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(item)
      expect(screen.queryByTestId('admin-orders-bulk-dialog')).toBeNull()
      await user.keyboard('{Escape}')
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-orders-row-cancel-${orderNumber}`)).toBeNull(),
      )
    }
    expect(writes).toEqual([])
  })
})
