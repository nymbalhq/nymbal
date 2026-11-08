import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@/tests/render'
import { useAssistant } from '@/hooks/useAssistant'
import { formatMoney } from '@/lib/money'
import { AssistantPanel } from './AssistantPanel'

// The Ask panel's record cards: a `record` frame names an order or a customer the turn read, and the panel shows a
// card filled by the admin's own session from the store's admin API, never from the frame or the answer. The server is
// faked at fetch (the order and customer reads, and each turn POST recorded) and the stream at EventSource: a test
// plays the frames a turn would send.

/** An EventSource whose frames the test plays: one per turn, in the order the panel opened them. */
class ScriptedSource {
  static opened: ScriptedSource[] = []
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()

  constructor(readonly url: string) {
    ScriptedSource.opened.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {}

  play(event: string, data: unknown) {
    const message = new MessageEvent(event, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(event) ?? []) listener(message)
  }
}

const ORDER_NUMBER = 'NYM-1042'
const MISSING = 'NYM-0404'
const CUSTOMER_ID = 'cus_7a1'

const SHIPPING = {
  firstName: 'Imogen',
  lastName: 'Thackeray',
  addressLine1: '12 Acacia Avenue',
  city: 'Kingston upon Thames',
  region: 'Surrey',
  postalCode: 'KT1 4AB',
  country: 'GB',
  phone: '+44 7700 900461',
}

const ORDER = {
  id: 'ord_1042',
  orderNumber: ORDER_NUMBER,
  sequence: 1042,
  customerId: CUSTOMER_ID,
  status: 'shipped',
  email: 'imogen.reader@example.com',
  billingAddress: { ...SHIPPING, addressLine1: '9 Billing Row', postalCode: 'B1 1BB' },
  shippingAddress: SHIPPING,
  lineItems: [],
  subtotalMinor: 12_345,
  taxTotalMinor: 0,
  shippingTotalMinor: 0,
  discountTotalMinor: 0,
  totalMinor: 12_345,
  currency: 'GBP',
  notes: '',
  metadata: {},
  paymentIntentId: null,
  capturedMinor: 12_345,
  capturedAt: '2026-11-01T09:00:00.000Z',
  refundedMinor: 0,
  captureMethod: 'provider',
  source: 'storefront',
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  payment: {
    state: 'paid',
    capturedMinor: 12_345,
    refundedMinor: 0,
    refundableMinor: 12_345,
    currency: 'GBP',
    refunds: [],
  },
  history: [],
}

const CUSTOMER = {
  customer: {
    id: CUSTOMER_ID,
    email: 'oluwaseun.regular@example.com',
    firstName: 'Oluwaseun',
    lastName: 'Adeyemi',
    phone: '+44 7700 900777',
    addresses: [],
    orderCount: 17,
    totalSpentMinor: 98_765,
    metadata: {},
    roles: ['customer'],
    requiresPasswordReset: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  stats: {
    orderCount: 17,
    lifetimeRevenueMinor: 98_765,
    avgOrderValueMinor: 5_810,
    firstOrderAt: '2026-01-02T00:00:00.000Z',
    lastOrderAt: '2026-10-30T00:00:00.000Z',
  },
}

/** What the order card must show, each as the mocked API answers it (the total in the admin's own format). */
const ORDER_VALUES = [
  `${SHIPPING.firstName} ${SHIPPING.lastName}`,
  ORDER.email,
  SHIPPING.phone,
  SHIPPING.addressLine1,
  SHIPPING.city,
  SHIPPING.postalCode,
  SHIPPING.country,
  ORDER.status,
  formatMoney(ORDER.totalMinor, ORDER.currency),
]
const CUSTOMER_VALUES = [
  `${CUSTOMER.customer.firstName} ${CUSTOMER.customer.lastName}`,
  CUSTOMER.customer.email,
  CUSTOMER.customer.phone,
  String(CUSTOMER.stats.orderCount),
]

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function fakeServer() {
  const posted: Array<{ messages: Array<Record<string, unknown>>; page?: string }> = []
  ScriptedSource.opened = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-token' } })
    if (url.pathname === '/api/admin/assistant/turns' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as (typeof posted)[number])
      return json({ data: { turnId: `turn-${posted.length}`, ticket: 't', expiresIn: 60 } })
    }
    if (url.pathname === `/api/admin/orders/${ORDER_NUMBER}`) return json({ data: ORDER })
    if (url.pathname === `/api/admin/customers/${CUSTOMER_ID}`) return json({ data: CUSTOMER })
    if (url.pathname.startsWith('/api/admin/orders/')) {
      return json({ error: { code: 'orders.not_found', message: 'Order not found' } }, 404)
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  vi.stubGlobal('EventSource', ScriptedSource)
  return { posted }
}

function Panel() {
  const [draft, setDraft] = useState('')
  return <AssistantPanel draft={draft} onDraftChange={setDraft} />
}

type Played = { event: string; data: unknown }

/** Asks `question` through the panel's input and plays `frames` on its stream, then done. */
async function ask(question: string, frames: Played[], answer: string) {
  const opened = ScriptedSource.opened.length
  const input = screen.getByTestId('admin-assistant-input')
  fireEvent.change(input, { target: { value: question } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(ScriptedSource.opened.length).toBe(opened + 1))
  const source = ScriptedSource.opened.at(-1)!
  for (const frame of frames) source.play(frame.event, frame.data)
  source.play('text', { delta: answer })
  source.play('done', { text: answer, steps: frames.length, proposals: [] })
  await waitFor(() => expect(useAssistant.getState().busy).toBe(false))
}

const textOf = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ')
const missingFrom = (el: HTMLElement, values: readonly string[]) =>
  values.filter((v) => !textOf(el).toLowerCase().includes(v.toLowerCase()))

const ORDER_CARD = `admin-assistant-record-order-${ORDER_NUMBER}`
const CUSTOMER_CARD = `admin-assistant-record-customer-${CUSTOMER_ID}`
const MISSING_CARD = `admin-assistant-record-order-${MISSING}`

const scrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  useAssistant.setState({ exchanges: [], busy: false })
  Element.prototype.scrollIntoView = () => undefined
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Element.prototype.scrollIntoView = scrollIntoView
})

const tool = (name: string) => ({ event: 'tool', data: { name, title: name, ok: true } })
const record = (data: Record<string, string>) => ({ event: 'record', data })

describe('AC-11: a record frame shows a card filled from the admin API', () => {
  it('AC-11: an order frame shows the order card holding the shipping name, email, phone, street line, city, postcode, country, status and total GET /api/admin/orders/<n> answers, its link /orders/<n>; a customer frame shows the customer card with the name, email, phone and order count GET /api/admin/customers/<id> answers, its link /customers/<id>; the same record twice shows one card', async () => {
    fakeServer()
    renderWithProviders(<Panel />, { initialPath: '/orders' })

    await ask(
      `Who placed order #${ORDER_NUMBER}?`,
      [
        tool('admin_orders_get'),
        record({ kind: 'order', orderNumber: ORDER_NUMBER }),
        tool('admin_customers_get'),
        record({ kind: 'customer', id: CUSTOMER_ID }),
        tool('admin_orders_get'),
        record({ kind: 'order', orderNumber: ORDER_NUMBER }),
      ],
      'It was placed by the customer shown below.',
    )

    const order = await screen.findByTestId(ORDER_CARD)
    const customer = await screen.findByTestId(CUSTOMER_CARD)
    await waitFor(() => expect(missingFrom(order, ORDER_VALUES)).toEqual([]))
    await waitFor(() => expect(missingFrom(customer, CUSTOMER_VALUES)).toEqual([]))

    expect(
      within(order)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toContain(`/orders/${ORDER_NUMBER}`)
    expect(
      within(customer)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toContain(`/customers/${CUSTOMER_ID}`)
    expect(screen.getAllByTestId(ORDER_CARD).length).toBe(1)
    // The values came from the API: neither the frames nor the answer held any of them.
    expect(missingFrom(screen.getByTestId('admin-assistant-answer'), ORDER_VALUES)).toEqual(
      ORDER_VALUES,
    )
  })

  it('AC-11: an order the API answers 404 for shows "Order <n> was not found" and none of an order’s values', async () => {
    fakeServer()
    renderWithProviders(<Panel />, { initialPath: '/orders' })

    await ask(
      `Who placed order #${MISSING}?`,
      [tool('admin_orders_get'), record({ kind: 'order', orderNumber: MISSING })],
      'I could not find it.',
    )

    const card = await screen.findByTestId(MISSING_CARD)
    await waitFor(() => expect(textOf(card)).toContain(`Order ${MISSING} was not found`))
    expect(missingFrom(card, ORDER_VALUES)).toEqual(ORDER_VALUES)
    expect(textOf(card)).not.toMatch(/[@£]/)
  })

  it('AC-11: the next question’s turn POST holds no record and no card value: each message is its role and content (and revealed spans) only', async () => {
    const server = fakeServer()
    renderWithProviders(<Panel />, { initialPath: '/orders' })

    await ask(
      `Who placed order #${ORDER_NUMBER}?`,
      [
        tool('admin_orders_get'),
        record({ kind: 'order', orderNumber: ORDER_NUMBER }),
        tool('admin_customers_get'),
        record({ kind: 'customer', id: CUSTOMER_ID }),
      ],
      'It was placed by the customer shown below.',
    )
    const order = await screen.findByTestId(ORDER_CARD)
    await waitFor(() => expect(missingFrom(order, ORDER_VALUES)).toEqual([]))
    await ask('And what else did they buy?', [], 'Nothing else.')

    const next = server.posted[1]!
    const sent = JSON.stringify(next)
    expect(server.posted.length).toBe(2)
    expect([...ORDER_VALUES, ...CUSTOMER_VALUES].filter((v) => sent.includes(v))).toEqual([])
    expect(
      next.messages.flatMap((m) =>
        Object.keys(m).filter((k) => !['role', 'content', 'revealed'].includes(k)),
      ),
    ).toEqual([])
    expect(sent.includes(CUSTOMER_ID)).toBe(false)
  })
})
