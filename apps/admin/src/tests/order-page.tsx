import { Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import { OrderDetailPage } from '@/pages/OrderDetailPage'
import { renderWithProviders } from '@/tests/render'

// The order page against a fake admin API (fetch stubbed): an order whose server copy a test can change, every write
// recorded with its Idempotency-Key and body, and answers a test may hold back until it releases them.

const AT = '2026-10-20T10:00:00.000Z'
const UNPAID: readonly OrderStatus[] = ['pending', 'cancelled']

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Part. Refunded',
}

const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

/** An admin order read in `status`: paid unless pending or cancelled. */
export function orderIn(
  status: OrderStatus,
  overrides: { id?: string; orderNumber?: string } = {},
) {
  const paid = !UNPAID.includes(status)
  const capturedMinor = paid ? 2500 : 0
  const refundedMinor = status === 'refunded' ? 2500 : status === 'partially_refunded' ? 1000 : 0
  return {
    id: overrides.id ?? 'o-1',
    orderNumber: overrides.orderNumber ?? 'NYM-1001',
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

export type OrderFixture = ReturnType<typeof orderIn>

export interface Answer {
  status: number
  body: unknown
}

export interface Write {
  /** The last path segment: `ship`, `mark-paid`, `cancel`, … */
  action: string
  key: string | null
  body: unknown
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** A refusal in the API's error envelope. */
export const refusal = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
})

/** A successful write: the order in `status`, as the admin routes answer it. */
export function movedTo(order: OrderFixture, status: OrderStatus): Answer {
  const { history: _history, ...moved } = orderIn(status, order)
  return { status: 200, body: { data: moved } }
}

/**
 * The admin API for one order. `answer` answers each write; it may change the server's copy (`setServer`) before it
 * answers, as another admin or a webhook would. `answered` counts the writes whose answer has been sent.
 */
export function fakeOrderApi(
  order: OrderFixture,
  answer: (write: Write) => Answer | Promise<Answer>,
) {
  let server = order
  let detailReads = 0
  let answered = 0
  const writes: Write[] = []
  const prefix = `/api/admin/orders/${order.id}/`
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname
    if (path === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && path === `/api/admin/orders/${order.orderNumber}`) {
      detailReads += 1
      return json({ data: server })
    }
    if (method === 'GET' && path === `${prefix}notes`) return json({ data: [] })
    if (method !== 'GET' && path.startsWith(prefix)) {
      const write: Write = {
        action: path.slice(prefix.length),
        key: new Headers(init.headers).get('idempotency-key'),
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      }
      writes.push(write)
      const a = await answer(write)
      answered += 1
      return json(a.body, a.status)
    }
    return json({ data: {} })
  })
  return {
    writes,
    /** The writes sent to one action, in order. */
    writesTo: (action: string) => writes.filter((w) => w.action === action),
    setServer(status: OrderStatus) {
      server = orderIn(status, order)
    },
    get detailReads() {
      return detailReads
    },
    get answered() {
      return answered
    },
  }
}

/** An answer the test releases when it chooses. */
export function held(a: Answer) {
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

export function renderOrderPage(order: OrderFixture): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <Routes>
      <Route path="/orders/:orderNumber" element={<OrderDetailPage />} />
    </Routes>,
    { initialPath: `/orders/${order.orderNumber}` },
  )
}

/** Radix measures and captures the pointer, which jsdom does not implement. */
export function polyfillRadix(): void {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
}
