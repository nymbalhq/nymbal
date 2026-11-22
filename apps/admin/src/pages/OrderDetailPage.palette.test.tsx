import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import { CommandPalette, CommandPaletteButton } from '@/components/common/CommandPalette'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import {
  STATUS_LABEL,
  movedTo,
  orderIn,
  polyfillRadix,
  refusal,
  type Answer,
  type OrderFixture,
} from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { OrderDetailPage } from './OrderDetailPage'

// The palette over the order page, against a fake admin API (fetch stubbed) holding several orders: which commands it
// lists for the order on screen, and that each runs the page's own path, once.

const FIELD = { name: 'Search or run a command' }
const BADGE = 'admin-order-status-badge'

/** What each write moves the order to when the server accepts it. */
const MOVES: Record<string, OrderStatus> = {
  process: 'processing',
  'mark-paid': 'confirmed',
  'mark-delivered': 'delivered',
  ship: 'shipped',
  cancel: 'cancelled',
}

interface SentWrite {
  orderNumber: string
  action: string
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/**
 * The admin API for these orders. A write is answered by `answerWith` (by default the server accepts it and its copy
 * moves); a detail read of a held order waits until the test releases it.
 */
function fakeAdminApi(initial: OrderFixture[]) {
  const server = new Map(initial.map((o) => [o.orderNumber, o]))
  const numberOf = new Map(initial.map((o) => [o.id, o.orderNumber]))
  const heldReads = new Map<string, Promise<void>>()
  const writes: SentWrite[] = []
  const searches: string[] = []
  let answered = 0

  const api = {
    writes,
    searches,
    get answered() {
      return answered
    },
    writesTo: (action: string, orderNumber?: string) =>
      writes.filter(
        (w) => w.action === action && (orderNumber === undefined || w.orderNumber === orderNumber),
      ),
    setServer(orderNumber: string, status: OrderStatus) {
      const now = server.get(orderNumber)!
      server.set(orderNumber, orderIn(status, now))
    },
    /** The server's answer to a write; by default it accepts and moves its copy. */
    answerWith: (write: SentWrite): Answer | Promise<Answer> => {
      const now = server.get(write.orderNumber)!
      if (write.action === 'resend-confirmation') {
        return {
          status: 200,
          body: { data: { orderId: now.id, orderNumber: now.orderNumber, email: now.email } },
        }
      }
      const to = MOVES[write.action]!
      api.setServer(write.orderNumber, to)
      return movedTo(now, to)
    },
    /** Holds every detail read of `orderNumber` until the returned release is called. */
    holdReads(orderNumber: string) {
      let release: () => void = () => {}
      heldReads.set(
        orderNumber,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return () => {
        heldReads.delete(orderNumber)
        release()
      }
    },
  }

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname
    if (path === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && path === '/api/admin/search') {
      const q = url.searchParams.get('q') ?? ''
      searches.push(q)
      const orders = [...server.values()].filter((o) => o.orderNumber.includes(q))
      return json({ data: { orders, products: [], customers: [] } })
    }
    const detail = /^\/api\/admin\/orders\/([^/]+)$/.exec(path)
    if (method === 'GET' && detail && server.has(detail[1]!)) {
      const n = detail[1]!
      await heldReads.get(n)
      return json({ data: server.get(n) })
    }
    const write = /^\/api\/admin\/orders\/([^/]+)\/([a-z-]+)$/.exec(path)
    if (method !== 'GET' && write && numberOf.has(write[1]!)) {
      const sent = { orderNumber: numberOf.get(write[1]!)!, action: write[2]! }
      writes.push(sent)
      const a = await api.answerWith(sent)
      answered += 1
      return json(a.body, a.status)
    }
    if (method === 'GET' && path.endsWith('/notes')) return json({ data: [] })
    return json({ data: {} })
  })
  return api
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

function renderAdmin(initialPath: string) {
  return renderWithProviders(
    <>
      <CommandPaletteButton />
      <CommandPalette />
      <Where />
      <Routes>
        <Route path="/" element={<p>Dashboard page</p>} />
        <Route path="/orders" element={<p>Orders page</p>} />
        <Route path="/orders/:orderNumber" element={<OrderDetailPage />} />
        <Route path="/products" element={<p>Products page</p>} />
        <Route path="/inventory" element={<p>Inventory page</p>} />
        <Route path="*" element={<p>Another page</p>} />
      </Routes>
    </>,
    { initialPath },
  )
}

type User = ReturnType<typeof userEvent.setup>

/** Opens the palette by its shortcut; the field it returns is the proof it is open. */
async function openPalette(user: User): Promise<HTMLElement> {
  await user.keyboard('{Control>}k{/Control}')
  return screen.findByRole('combobox')
}

const paletteClosed = () =>
  waitFor(() => expect(screen.queryByRole('combobox', FIELD)).not.toBeInTheDocument())

const anyOrderGroup = () => screen.queryByRole('group', { name: /^Order #/ })

const labelsIn = (group: HTMLElement) =>
  within(group)
    .getAllByRole('option')
    .map((o) => o.textContent?.trim() ?? '')

async function badgeReads(status: OrderStatus) {
  await waitFor(() => expect(screen.getByTestId(BADGE)).toHaveTextContent(STATUS_LABEL[status]), {
    timeout: 5000,
  })
}

/** Opens the palette on the order's page and chooses one of the order's commands by its label. */
async function choose(user: User, order: OrderFixture, label: string) {
  await openPalette(user)
  const group = await screen.findByRole('group', { name: `Order #${order.orderNumber}` })
  await user.click(within(group).getByRole('option', { name: label }))
}

beforeAll(polyfillRadix)

afterEach(() => {
  act(() => useCommandPalette.getState().close())
  vi.unstubAllGlobals()
})

describe('the palette lists the commands of the order on screen', () => {
  // Kills: a scope left over from a page that is gone, so a command acts on an order no longer shown.
  it('AC-5: on a confirmed, paid order’s page the group "Order #n" comes first and holds exactly what the order can take; after going to Orders, Products and the Dashboard there is no order group', async () => {
    const order = orderIn('confirmed')
    fakeAdminApi([order])
    const user = userEvent.setup()
    renderAdmin(`/orders/${order.orderNumber}`)
    await badgeReads('confirmed')

    await openPalette(user)
    const group = await screen.findByRole('group', { name: `Order #${order.orderNumber}` })
    expect(labelsIn(group)).toEqual(['Mark processing', 'Issue refund', 'Resend confirmation'])
    expect(screen.getAllByRole('option')[0], 'the first option of the palette').toBe(
      within(group).getAllByRole('option')[0],
    )

    const seen: Record<string, boolean> = {}
    for (const [label, path] of [
      ['Go to Orders', '/orders'],
      ['Go to Products', '/products'],
      ['Go to Dashboard', '/'],
    ] as const) {
      await user.click(screen.getByRole('option', { name: label }))
      await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(path))
      await openPalette(user)
      await screen.findByRole('group', { name: 'Go to' })
      seen[path] = anyOrderGroup() !== null
    }
    expect(seen, 'an order group on a page that is not an order').toEqual({
      '/orders': false,
      '/products': false,
      '/': false,
    })
  })

  // Kills: one component instance keeping order A's commands while B loads, and a scope frozen at first load.
  it('AC-5: moving in place from order A to order B shows no order group while B loads, then "Order #B" with B’s commands, and they follow B when its status changes', async () => {
    const a = orderIn('confirmed', { id: 'o-1', orderNumber: 'NYM-1001' })
    const b = orderIn('shipped', { id: 'o-2', orderNumber: 'NYM-1002' })
    const api = fakeAdminApi([a, b])
    const user = userEvent.setup()
    const { queryClient } = renderAdmin(`/orders/${a.orderNumber}`)
    await badgeReads('confirmed')

    const field = await openPalette(user)
    await screen.findByRole('group', { name: `Order #${a.orderNumber}` })
    const releaseB = api.holdReads(b.orderNumber)
    await user.type(field, b.orderNumber)
    const results = await screen.findByRole('group', { name: 'Orders' }, { timeout: 3000 })
    await user.click(within(results).getByRole('option', { name: new RegExp(b.orderNumber) }))
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe(`/orders/${b.orderNumber}`),
    )

    await openPalette(user)
    await screen.findByRole('group', { name: 'Go to' })
    expect(anyOrderGroup(), 'an order group while B’s order is still loading').toBeNull()
    await user.keyboard('{Escape}')
    await paletteClosed()

    releaseB()
    await badgeReads('shipped')
    await openPalette(user)
    const groupB = await screen.findByRole('group', { name: `Order #${b.orderNumber}` })
    expect(labelsIn(groupB)).toEqual(['Mark delivered', 'Issue refund', 'Resend confirmation'])
    expect(screen.queryByRole('group', { name: `Order #${a.orderNumber}` })).toBeNull()
    await user.keyboard('{Escape}')
    await paletteClosed()

    api.setServer(b.orderNumber, 'delivered')
    await act(() => queryClient.invalidateQueries())
    await badgeReads('delivered')
    await openPalette(user)
    const after = await screen.findByRole('group', { name: `Order #${b.orderNumber}` })
    expect(labelsIn(after)).toEqual(['Issue refund', 'Resend confirmation'])
  })

  // Kills: the order's commands listed unfiltered and highlighted first, so "inv" + Enter records a payment.
  it('AC-5: on a pending order’s page "inv" shows no order group and Enter goes to /inventory with no write', async () => {
    const order = orderIn('pending')
    const api = fakeAdminApi([order])
    const user = userEvent.setup()
    renderAdmin(`/orders/${order.orderNumber}`)
    await badgeReads('pending')

    const field = await openPalette(user)
    await screen.findByRole('group', { name: `Order #${order.orderNumber}` })
    await user.type(field, 'inv')
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Go to' }))
          .getAllByRole('option')
          .map((o) => o.textContent?.trim()),
      ).toEqual(['Go to Inventory']),
    )
    expect(anyOrderGroup(), 'an order group with no command matching "inv"').toBeNull()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/inventory'))

    // A write the Enter set off would be sent by the time a later search has gone out.
    const again = await openPalette(user)
    await user.type(again, 'zz')
    await waitFor(() => expect(api.searches).toContain('zz'), { timeout: 3000 })
    expect(api.writes).toEqual([])
  })
})

describe('a palette command does what the page’s control does', () => {
  // Kills: the palette calling its own copy of an action, which drops the refusal, skips a dialog or cancels with no
  // confirmation.
  const SENDS: Array<{ label: string; from: OrderStatus; action: string; to: OrderStatus }> = [
    { label: 'Mark processing', from: 'confirmed', action: 'process', to: 'processing' },
    { label: 'Record payment', from: 'pending', action: 'mark-paid', to: 'confirmed' },
    { label: 'Mark delivered', from: 'shipped', action: 'mark-delivered', to: 'delivered' },
  ]
  for (const c of SENDS) {
    it(`AC-6: ${c.label} sends one POST …/${c.action}, the palette closes, and the badge reads ${STATUS_LABEL[c.to]} after the answer`, async () => {
      const order = orderIn(c.from)
      const api = fakeAdminApi([order])
      const user = userEvent.setup()
      renderAdmin(`/orders/${order.orderNumber}`)
      await badgeReads(c.from)

      await choose(user, order, c.label)
      await paletteClosed()
      await waitFor(() => expect(api.answered).toBe(1))
      await badgeReads(c.to)
      expect(api.writes).toEqual([{ orderNumber: order.orderNumber, action: c.action }])
    })
  }

  it('AC-6: Mark processing answered 409 shows the answer’s message in the page’s action error', async () => {
    const order = orderIn('confirmed')
    const message = 'Order NYM-1001 is fully refunded: nothing to process'
    const api = fakeAdminApi([order])
    api.answerWith = () => refusal(409, 'order.refunded', message)
    const user = userEvent.setup()
    renderAdmin(`/orders/${order.orderNumber}`)
    await badgeReads('confirmed')

    await choose(user, order, 'Mark processing')
    await paletteClosed()

    await waitFor(() =>
      expect(screen.getByTestId('admin-order-action-error')).toHaveTextContent(message),
    )
    expect(api.writesTo('process')).toHaveLength(1)
  })

  it('AC-6: Resend confirmation sends one POST …/resend-confirmation and the page says where it was queued', async () => {
    const order = orderIn('confirmed')
    const api = fakeAdminApi([order])
    const user = userEvent.setup()
    renderAdmin(`/orders/${order.orderNumber}`)
    await badgeReads('confirmed')

    await choose(user, order, 'Resend confirmation')
    await paletteClosed()

    await waitFor(() =>
      expect(screen.getByTestId('admin-order-resend-result')).toHaveTextContent(order.email),
    )
    expect(api.writes).toEqual([{ orderNumber: order.orderNumber, action: 'resend-confirmation' }])
  })

  const DIALOGS: Array<{ label: string; from: OrderStatus; dialog: string }> = [
    { label: 'Mark shipped', from: 'processing', dialog: 'admin-order-ship-dialog' },
    { label: 'Issue refund', from: 'confirmed', dialog: 'admin-order-refund-dialog' },
  ]
  for (const c of DIALOGS) {
    it(`AC-6: ${c.label} opens the page’s dialog and sends nothing`, async () => {
      const order = orderIn(c.from)
      const api = fakeAdminApi([order])
      const user = userEvent.setup()
      renderAdmin(`/orders/${order.orderNumber}`)
      await badgeReads(c.from)

      await choose(user, order, c.label)
      await paletteClosed()

      expect(await screen.findByTestId(c.dialog)).toHaveTextContent(`#${order.orderNumber}`)
      expect(api.writes).toEqual([])
    })
  }

  it('AC-6: Cancel order asks first in the one-order confirmation, sending nothing, and its submit sends one POST …/cancel', async () => {
    const order = orderIn('pending')
    const api = fakeAdminApi([order])
    const user = userEvent.setup()
    renderAdmin(`/orders/${order.orderNumber}`)
    await badgeReads('pending')

    await choose(user, order, 'Cancel order')
    await paletteClosed()

    const dialog = await screen.findByTestId('admin-orders-bulk-dialog')
    expect(within(dialog).getByTestId('admin-orders-bulk-summary')).toHaveTextContent(/^1 order\b/)
    expect(api.writes, 'writes before the confirmation').toEqual([])

    await user.click(within(dialog).getByTestId('admin-orders-bulk-submit'))
    await waitFor(() => expect(api.answered).toBe(1))
    await badgeReads('cancelled')
    expect(api.writes).toEqual([{ orderNumber: order.orderNumber, action: 'cancel' }])
  })
})

describe('one choice is one command', () => {
  // Kills: the palette's run bypassing the page's in-flight guard, so one intent moves the order twice or records two
  // payments.
  const resultNames = async (order: OrderFixture) => {
    await waitFor(() =>
      expect(screen.getByTestId('admin-order-resend-result')).toHaveTextContent(order.email),
    )
  }
  const ONCE: Array<{
    label: string
    from: OrderStatus
    action: string
    settled: (order: OrderFixture) => Promise<void>
  }> = [
    {
      label: 'Mark processing',
      from: 'confirmed',
      action: 'process',
      settled: () => badgeReads('processing'),
    },
    {
      label: 'Record payment',
      from: 'pending',
      action: 'mark-paid',
      settled: () => badgeReads('confirmed'),
    },
    {
      label: 'Resend confirmation',
      from: 'confirmed',
      action: 'resend-confirmation',
      settled: resultNames,
    },
  ]
  for (const c of ONCE) {
    for (const k of [2, 5]) {
      it(`AC-7: ${k} Enter presses on ${c.label} in one act, and choosing it again while its POST is held, send one POST`, async () => {
        const order = orderIn(c.from)
        const api = fakeAdminApi([order])
        const accept = api.answerWith
        let release: () => void = () => {}
        const opened = new Promise<void>((resolve) => {
          release = resolve
        })
        api.answerWith = async (write) => {
          await opened
          return accept(write)
        }
        const user = userEvent.setup()
        renderAdmin(`/orders/${order.orderNumber}`)
        await badgeReads(c.from)

        const field = await openPalette(user)
        await user.type(field, c.label)
        const group = await screen.findByRole('group', { name: `Order #${order.orderNumber}` })
        const option = within(group).getByRole('option', { name: c.label })
        await waitFor(() => expect(option).toHaveAttribute('aria-selected', 'true'))

        act(() => {
          for (let i = 0; i < k; i += 1) {
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          }
        })
        await waitFor(() => expect(api.writesTo(c.action).length).toBeGreaterThan(0))

        const reopened = await openPalette(user)
        await user.type(reopened, c.label)
        await user.keyboard('{Enter}')
        const sentInFlight = api.writesTo(c.action).length

        release()
        await waitFor(() => expect(api.answered).toBe(api.writes.length))
        await c.settled(order)

        expect(sentInFlight, `${c.action} POSTs from ${k} presses and a second choice`).toBe(1)
        expect(api.writesTo(c.action).length, `${c.action} POSTs once settled`).toBe(sentInFlight)
      })
    }
  }
})
