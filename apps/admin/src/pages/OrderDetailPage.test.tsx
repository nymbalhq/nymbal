import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { OrderDetailPage } from './OrderDetailPage'

// The order page's "Resend confirmation" item, against a fake admin API (fetch stubbed): when it may be selected,
// what one selection and a double selection send, the item while the request is in flight, and what the page then
// says.

const STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]
const UNPAID: readonly OrderStatus[] = ['pending', 'cancelled']
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const AT = '2026-10-20T10:00:00.000Z'
const ITEM = 'admin-order-action-resend-confirmation'
const RESULT = 'admin-order-resend-result'

const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

function orderIn(status: OrderStatus) {
  const paid = !UNPAID.includes(status)
  const refundedMinor = status === 'refunded' ? 2500 : status === 'partially_refunded' ? 1000 : 0
  const capturedMinor = paid ? 2500 : 0
  return {
    id: 'o-1',
    orderNumber: 'NYM-1001',
    sequence: 1001,
    customerId: null,
    status,
    email: 'ada.buyer@orders.test',
    billingAddress: ADDRESS,
    shippingAddress: ADDRESS,
    lineItems: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        productName: 'Widget',
        variantName: 'Default',
        sku: 'W-1',
        qty: 1,
        unitPriceMinor: 2500,
        lineSubtotalMinor: 2500,
        lineTaxMinor: 0,
        lineTotalMinor: 2500,
        imageUrl: '',
      },
    ],
    subtotalMinor: 2500,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 2500,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: null,
    capturedMinor,
    capturedAt: paid ? AT : null,
    refundedMinor,
    captureMethod: paid ? 'provider' : null,
    createdAt: AT,
    updatedAt: AT,
    payment: {
      state: !paid
        ? 'unpaid'
        : refundedMinor === 0
          ? 'paid'
          : refundedMinor < capturedMinor
            ? 'partially_refunded'
            : 'refunded',
      capturedMinor,
      refundedMinor,
      refundableMinor: capturedMinor - refundedMinor,
      currency: 'GBP',
      refunds: [],
    },
    history: [],
  }
}

type OrderFixture = ReturnType<typeof orderIn>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

interface Answer {
  status: number
  body: unknown
}

/**
 * The admin API for the order page. Each resend POST is recorded with its Idempotency-Key and answered by `answer`,
 * which may hold the answer back until the test releases it.
 */
function fakeApi(order: OrderFixture, answer: () => Answer | Promise<Answer>) {
  const resends: Array<{ key: string | null }> = []
  const resendPath = `/api/admin/orders/${order.id}/resend-confirmation`
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname
    if (path === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && path === `/api/admin/orders/${order.orderNumber}`) {
      return json({ data: order })
    }
    if (method === 'GET' && path === `/api/admin/orders/${order.id}/notes`)
      return json({ data: [] })
    if (method === 'POST' && path === resendPath) {
      resends.push({ key: new Headers(init.headers).get('idempotency-key') })
      const a = await answer()
      return json(a.body, a.status)
    }
    return json({ data: {} })
  })
  return { resends }
}

/** An answer the test releases when it chooses. */
function held(a: Answer) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    answer: async () => {
      await gate
      return a
    },
    release,
  }
}

const queued = (order: OrderFixture): Answer => ({
  status: 200,
  body: { data: { orderId: order.id, orderNumber: order.orderNumber, email: order.email } },
})

function renderPage(order: OrderFixture) {
  return renderWithProviders(
    <Routes>
      <Route path="/orders/:orderNumber" element={<OrderDetailPage />} />
    </Routes>,
    { initialPath: `/orders/${order.orderNumber}` },
  )
}

/** Opens the Actions menu and answers the resend item in it. */
async function openItem(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByTestId('admin-order-actions', undefined, { timeout: 5000 }))
  return screen.findByTestId(ITEM)
}

const disabled = (item: HTMLElement): boolean =>
  item.getAttribute('aria-disabled') === 'true' ||
  item.hasAttribute('data-disabled') ||
  (item as HTMLButtonElement).disabled === true

beforeAll(() => {
  // Radix measures and captures the pointer, which jsdom does not implement.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the order page’s Resend confirmation item', () => {
  // Kills: the item enabled on an order no confirmation is due for, or disabled on a paid one; a disabled item that
  // still sends.
  it('AC-9: the item is disabled exactly for a pending and a cancelled order, and selecting it there sends nothing', async () => {
    const seen: Record<string, boolean> = {}
    let sentWhileDisabled = 0
    for (const status of STATUSES) {
      const order = orderIn(status)
      const api = fakeApi(order, () => queued(order))
      const user = userEvent.setup()
      const view = renderPage(order)
      const item = await openItem(user)
      seen[status] = disabled(item)
      if (seen[status]) {
        await user.click(item)
        sentWhileDisabled += api.resends.length
      }
      // Closed before the next page: an open menu leaves the body without pointer events.
      await user.keyboard('{Escape}')
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(seen).toEqual(Object.fromEntries(STATUSES.map((s) => [s, UNPAID.includes(s)])))
    expect(sentWhileDisabled, 'resends sent from a disabled item').toBe(0)
  })

  // Kills: the item left unwired; a result that does not name where the confirmation went.
  it('AC-9: selecting the item on a confirmed order sends one POST …/resend-confirmation with a well-formed Idempotency-Key, and the result then names the order’s email', async () => {
    const order = orderIn('confirmed')
    const api = fakeApi(order, () => queued(order))
    const user = userEvent.setup()
    renderPage(order)

    await user.click(await openItem(user))

    await waitFor(() => expect(screen.getByTestId(RESULT)).toHaveTextContent(order.email))
    expect(api.resends.length, 'resend POSTs').toBe(1)
    expect(KEY_PATTERN.test(api.resends[0]!.key ?? ''), `key ${api.resends[0]!.key}`).toBe(true)
  })

  // Kills: each call given its own key, so a double click sends two resends; the item still enabled in flight; a key
  // never renewed, so the next resend is answered as a replay and mails nothing.
  it('AC-9: two selections before the re-render send one key; the item is disabled while that request is in flight and enabled once it settles, and the next selection sends a new key', async () => {
    const order = orderIn('processing')
    let gate = held(queued(order))
    const api = fakeApi(order, () => gate.answer())
    const user = userEvent.setup()
    renderPage(order)

    const item = await openItem(user)
    act(() => {
      item.click()
      item.click()
    })
    await waitFor(() => expect(api.resends.length).toBeGreaterThan(0))
    const firstKeys = api.resends.map((r) => r.key)
    expect(new Set(firstKeys).size, `keys ${JSON.stringify(firstKeys)}`).toBe(1)
    expect(KEY_PATTERN.test(firstKeys[0] ?? ''), `key ${firstKeys[0]}`).toBe(true)

    const inFlight = await openItem(user)
    const wasDisabled = disabled(inFlight)
    await user.keyboard('{Escape}')
    const sentBeforeSettle = api.resends.length
    const previous = gate
    gate = held(queued(order))
    previous.release()
    await waitFor(() => expect(screen.getByTestId(RESULT)).toHaveTextContent(order.email))

    const settled = await openItem(user)
    expect([wasDisabled, disabled(settled)], 'disabled in flight, then after it settles').toEqual([
      true,
      false,
    ])
    await user.click(settled)
    await waitFor(() => expect(api.resends.length).toBe(sentBeforeSettle + 1))
    expect(api.resends.at(-1)!.key, 'the next intent’s key').not.toBe(firstKeys[0])
    gate.release()
  })

  // Kills: a refusal shown as queued, or not shown at all.
  it('AC-9: when the resend is answered 409 the result shows the error’s message', async () => {
    const order = orderIn('shipped')
    const message = `Order ${order.orderNumber} is not paid: no confirmation is due`
    fakeApi(order, () => ({
      status: 409,
      body: { error: { code: 'order.unpaid', message, context: { status: 'pending' } } },
    }))
    const user = userEvent.setup()
    renderPage(order)

    await user.click(await openItem(user))

    await waitFor(() => expect(screen.getByTestId(RESULT)).toHaveTextContent(message))
    expect(screen.getByTestId(RESULT).textContent?.includes('queued')).toBe(false)
  })
})
