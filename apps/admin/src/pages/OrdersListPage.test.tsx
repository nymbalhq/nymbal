import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { orderIn, polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { OrdersListPage } from './OrdersListPage'

// The order list against a fake admin API that answers each query with the orders it names, so the page's filters are
// judged by the requests they send and the rows those bring back.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const FILTER = 'admin-orders-payment-filter'

const paid = { ...orderIn('shipped', { id: 'paid', orderNumber: 'NYM-PAID' }) }
const partly = { ...orderIn('confirmed', { id: 'part', orderNumber: 'NYM-PART', refundedMinor: 1000 }) }
const whole = { ...orderIn('confirmed', { id: 'all', orderNumber: 'NYM-ALL', refundedMinor: 2500 }) }
const ALL = [paid, partly, whole]

function stub() {
  const queries: Array<{ status: string | null; payment: string | null }> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname !== '/api/admin/orders') return json({ data: {} })
    const status = url.searchParams.get('status')
    const payment = url.searchParams.get('payment')
    queries.push({ status, payment })
    const rows = ALL.filter(
      (o) => (status === null || o.status === status) && (payment === null || o.payment.state === payment),
    )
    return json({ data: rows, meta: { total: rows.length } })
  })
  return queries
}

/** Picks a value of the payment control, a native select or the Radix one the status select uses. */
async function choosePayment(user: ReturnType<typeof userEvent.setup>, label: string) {
  const control = await screen.findByTestId(FILTER)
  if (control.tagName === 'SELECT') {
    await user.selectOptions(control, label)
    return
  }
  await user.click(control)
  await user.click(await screen.findByRole('option', { name: label }))
}

const shownRows = () =>
  screen
    .getAllByTestId(/^admin-orders-row-/)
    .map((r) => r.getAttribute('data-testid')!.replace('admin-orders-row-', ''))
    .sort()

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the admin order list’s filters', () => {
  // Kills: a money status chip surviving, or a fulfilment one going missing.
  it('AC-16: the status filter offers All and the six statuses, never Refunded or Partially refunded', async () => {
    stub()
    renderWithProviders(<OrdersListPage />)
    await screen.findByTestId('admin-orders-row-NYM-PAID')
    const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim())
    const expected = ['All', 'Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']
    expect(labels.filter((l) => expected.includes(l ?? ''))).toEqual(expected)
    expect(labels.filter((l) => l === 'Refunded' || l === 'Partially refunded')).toEqual([])
  })

  // Kills: the payment filter missing, requesting the wrong key, or coupled to the status filter.
  it('AC-16: choosing Refunded in the payment filter requests ?payment=refunded and shows only the orders it answers, and a status chip stays independent of it', async () => {
    const queries = stub()
    const user = userEvent.setup()
    renderWithProviders(<OrdersListPage />)
    await screen.findByTestId('admin-orders-row-NYM-PAID')
    expect(shownRows()).toEqual(['NYM-ALL', 'NYM-PAID', 'NYM-PART'])

    await choosePayment(user, 'Refunded')
    await waitFor(() => expect(shownRows()).toEqual(['NYM-ALL']))
    expect(shownRows().length, 'the filter narrows the list').toBeLessThan(ALL.length)
    expect(queries.at(-1)).toEqual({ status: null, payment: 'refunded' })

    await user.click(within(document.body).getByRole('button', { name: 'Confirmed' }))
    await waitFor(() => expect(queries.at(-1)).toEqual({ status: 'confirmed', payment: 'refunded' }))
    expect(shownRows()).toEqual(['NYM-ALL'])
  })
})
