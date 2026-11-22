import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Order } from '@nymbalhq/types'
import { createEventHandlers } from '@/realtime/handlers'
import {
  customer,
  fakeShellApi,
  inventoryRow,
  product,
  renderAdminShell,
  type ShellData,
} from '@/tests/admin-shell'
import { orderIn, polyfillRadix } from '@/tests/order-page'

// The orders, products, customers and inventory lists driven from the keyboard in the signed-in shell (fetch
// stubbed): the search field `/` reaches and Escape leaves, the row links `j` and `k` walk and Enter opens, and `x`
// selecting the order the merchant sees focused, whatever the live stream adds above it.

type User = ReturnType<typeof userEvent.setup>

const ORDERS = ['NYM-1001', 'NYM-1002', 'NYM-1003'].map((n, i) =>
  orderIn('confirmed', { id: `o-${i + 1}`, orderNumber: n }),
)
const PRODUCTS = [
  product('p-1', 'Linen Shirt', 'linen-shirt'),
  product('p-2', 'Wool Scarf', 'wool-scarf'),
  product('p-3', 'Cotton Tee', 'cotton-tee'),
]
const CUSTOMERS = [
  customer('c-1', 'jane@example.com', 'Jane', 'Doe'),
  customer('c-2', 'nameless@example.com', null, null),
  customer('c-3', 'sam@example.com', 'Sam', 'Lee'),
]

function seed(): ShellData {
  return fakeShellApi({
    orders: [...ORDERS],
    products: PRODUCTS,
    customers: CUSTOMERS,
    inventory: [inventoryRow(1), inventoryRow(2)],
  })
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const orderRow = (n: string) => screen.getByTestId(`admin-orders-row-${n}`)
const orderLink = (n: string) =>
  within(orderRow(n)).getByRole('link', { name: new RegExp(escape(n)) })
const orderBox = (n: string) => screen.getByRole('checkbox', { name: `Select order ${n}` })
const bulkCount = () => screen.queryByTestId('admin-orders-bulk-count')?.textContent?.trim() ?? null
const checkedOrders = () =>
  ORDERS.map((o) => o.orderNumber).filter(
    (n) => orderBox(n).getAttribute('aria-checked') === 'true',
  )

/** A Ctrl-click (Cmd on a Mac is the same path): a new tab, never this one. */
async function ctrlClick(user: User, el: Element) {
  await user.keyboard('[ControlLeft>]')
  await user.click(el)
  await user.keyboard('[/ControlLeft]')
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the search field', () => {
  const PAGES: Array<{ path: string; name: string; loaded: string }> = [
    { path: '/orders', name: 'Search orders', loaded: 'admin-orders-row-NYM-1001' },
    { path: '/products', name: 'Search products', loaded: 'admin-products-row-p-1' },
    { path: '/customers', name: 'Search customers', loaded: 'admin-customers-row-c-1' },
    { path: '/inventory', name: 'Search inventory', loaded: '' },
  ]

  // Kills: `/` typing a slash into the field, focusing nothing, or the field having no name (placeholder only).
  it('AC-5: / on the orders, products, customers and inventory pages focuses that page’s named search field, still empty', async () => {
    const user = userEvent.setup()
    const focused: string[] = []
    for (const page of PAGES) {
      seed()
      renderAdminShell(page.path)
      if (page.loaded) await screen.findByTestId(page.loaded)
      else await screen.findByText('SKU-1')
      const field = screen.getByLabelText(page.name)

      await user.keyboard('/')

      expect(document.activeElement, page.path).toBe(field)
      expect(field, page.path).toHaveValue('')
      focused.push(page.name)
      cleanup()
    }
    expect(focused).toEqual(PAGES.map((p) => p.name))
  })

  // Kills: no keyboard way out of the field short of Tab; Escape clearing the term.
  it('AC-5: a term then Escape leaves the field with the term kept, and the next j moves to the first row', async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')
    const field = screen.getByLabelText('Search orders')

    await user.keyboard('/')
    await user.keyboard('NYM')
    await user.keyboard('{Escape}')

    expect(document.activeElement).not.toBe(field)
    expect(field).toHaveValue('NYM')
    await screen.findByTestId('admin-orders-row-NYM-1001')
    await user.keyboard('j')
    expect(document.activeElement).toBe(orderLink('NYM-1001'))
    expect(field).toHaveValue('NYM')
  })

  // Kills: Escape that dismisses an IME candidate window blurring the field mid-word; Ctrl/Cmd/Alt-Escape read too.
  it('AC-5: Escape while composing, with keyCode 229, or with Ctrl, Meta or Alt held leaves focus in the field', async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')
    const field = screen.getByLabelText('Search orders')
    await user.keyboard('/')
    expect(document.activeElement, 'precondition: / focused the field').toBe(field)

    const variants: Array<[string, KeyboardEventInit]> = [
      ['composing', { isComposing: true }],
      ['keyCode 229', { keyCode: 229 }],
      ['Ctrl', { ctrlKey: true }],
      ['Meta', { metaKey: true }],
      ['Alt', { altKey: true }],
    ]
    for (const [what, init] of variants) {
      fireEvent.keyDown(field, { key: 'Escape', ...init })
      expect(document.activeElement, what).toBe(field)
    }

    fireEvent.keyDown(field, { key: 'Escape' })
    expect(document.activeElement, 'a plain Escape leaves').not.toBe(field)
  })
})

describe('the orders list', () => {
  // Kills: rows with no keyboard path; j/k by a stale index; running off either end.
  it('AC-6: j focuses the first order’s link, j the second, k the first; k on the first and j on the last stay', async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')
    const focusedRow = () =>
      ORDERS.map((o) => o.orderNumber).find((n) => orderRow(n).contains(document.activeElement)) ??
      null

    const walk: Array<string | null> = []
    for (const key of ['j', 'j', 'k', 'k', 'j', 'j', 'j', 'j']) {
      await user.keyboard(key)
      walk.push(focusedRow())
    }
    expect(walk).toEqual([
      'NYM-1001',
      'NYM-1002',
      'NYM-1001',
      'NYM-1001',
      'NYM-1002',
      'NYM-1003',
      'NYM-1003',
      'NYM-1003',
    ])
    expect(document.activeElement).toBe(orderLink('NYM-1003'))
  })

  // Kills: no link to Enter on; a link to another order.
  it('AC-6: Enter on a focused order link opens /orders/<n>', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')

    await user.keyboard('jj')
    expect(document.activeElement).toBe(orderLink('NYM-1002'))
    await user.keyboard('{Enter}')

    await waitFor(() => expect(shell.path()).toBe('/orders/NYM-1002'))
  })

  // Kills: a row or cell handler also navigating on a click meant for the link (a Ctrl-click opens a tab and moves
  // this one too).
  it('AC-6: a Ctrl-click on an order’s link leaves the URL unchanged; a plain click opens the order', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')

    await ctrlClick(user, orderLink('NYM-1001'))
    expect(shell.path(), 'after a Ctrl-click').toBe('/orders')

    await user.click(orderLink('NYM-1001'))
    await waitFor(() => expect(shell.path()).toBe('/orders/NYM-1001'))
  })

  // Kills: `x` with no row focused selecting one; `x` not reaching the checkbox, so the bulk bar disagrees.
  it('AC-6: x toggles the focused order’s checkbox and the bulk count follows; x with no row focused changes nothing', async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')

    await user.keyboard('x')
    expect(checkedOrders(), 'no row focused').toEqual([])
    expect(bulkCount()).toBeNull()

    const steps: Array<[keys: string, checked: string[]]> = [
      ['jx', ['NYM-1001']],
      ['jx', ['NYM-1001', 'NYM-1002']],
      ['x', ['NYM-1001']],
    ]
    for (const [keys, checked] of steps) {
      await user.keyboard(keys)
      expect(checkedOrders(), keys).toEqual(checked)
      expect(bulkCount(), 'the bulk count is the rows checked').toBe(
        `${checkedOrders().length} selected`,
      )
    }
  })

  // Kills: the active row as an index, so a live order shifts the merchant onto another order and `x` selects it.
  it('AC-6: with an order focused, a stream-placed order at the top leaves focus on it, x toggles it, and j moves to the one below it', async () => {
    const api = seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')

    await user.keyboard('jj')
    const b = orderLink('NYM-1002')
    expect(document.activeElement, 'precondition: B focused').toBe(b)

    const placed = orderIn('pending', { id: 'o-new', orderNumber: 'NYM-1004' })
    api.orders.unshift(placed)
    act(() => {
      createEventHandlers(shell.queryClient)('order.placed.v1', {
        order: placed as unknown as Order,
      })
    })
    await screen.findByTestId('admin-orders-row-NYM-1004')
    const rowOrder = screen
      .getAllByTestId(/^admin-orders-row-NYM-/)
      .map((r) => r.getAttribute('data-testid'))
    expect(rowOrder[0], 'the new order heads the list').toBe('admin-orders-row-NYM-1004')

    expect(document.activeElement, 'focus stays on B').toBe(orderLink('NYM-1002'))
    await user.keyboard('x')
    expect(orderBox('NYM-1002')).toHaveAttribute('aria-checked', 'true')
    expect(orderBox('NYM-1004')).toHaveAttribute('aria-checked', 'false')
    expect(bulkCount()).toBe('1 selected')

    await user.keyboard('j')
    expect(document.activeElement, 'next is the row below B').toBe(orderLink('NYM-1003'))
  })
})

interface ListCase {
  list: string
  path: string
  search: string
  rows: Array<{ id: string; testid: string; name: string; opens: string }>
  /** A cell of the row that is neither the link nor the menu. */
  otherCell: (row: HTMLElement) => HTMLElement
}

const LISTS: ListCase[] = [
  {
    list: 'products',
    path: '/products',
    search: 'Search products',
    rows: PRODUCTS.map((p) => ({
      id: p.id,
      testid: `admin-products-row-${p.id}`,
      name: p.name,
      opens: `/products/${p.slug}`,
    })),
    otherCell: (row) => within(row).getByText('£25.00'),
  },
  {
    list: 'customers',
    path: '/customers',
    search: 'Search customers',
    rows: CUSTOMERS.map((c) => ({
      id: c.id,
      testid: `admin-customers-row-${c.id}`,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email,
      opens: `/customers/${c.id}`,
    })),
    otherCell: (row) => within(row).getByText('£50.00'),
  },
]

const rowLink = (testid: string, name: string) =>
  within(screen.getByTestId(testid)).getByRole('link', { name: new RegExp(escape(name)) })

describe.each(LISTS)('the $list list', ({ path, search, rows, otherCell }) => {
  // Kills: rows reachable only by mouse; Enter opening the wrong record.
  it(`AC-7: j and k walk the row links, stopping at the ends, and Enter opens the record`, async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell(path)
    await screen.findByTestId(rows[0]!.testid)
    const focusedRow = () =>
      rows.find((r) => screen.getByTestId(r.testid).contains(document.activeElement))?.id ?? null

    const walk: Array<string | null> = []
    for (const key of ['j', 'j', 'k', 'k', 'j', 'j', 'j']) {
      await user.keyboard(key)
      walk.push(focusedRow())
    }
    const [a, b, c] = rows.map((r) => r.id)
    expect(walk).toEqual([a, b, a, a, b, c, c])

    await user.keyboard('kk')
    expect(document.activeElement).toBe(rowLink(rows[0]!.testid, rows[0]!.name))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(shell.path()).toBe(rows[0]!.opens))
  })

  // Kills: `x` acting on a list with nothing to select (moving focus, opening or navigating).
  it(`AC-7: x on a focused row does nothing`, async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell(path)
    await screen.findByTestId(rows[0]!.testid)

    await user.keyboard('j')
    const link = rowLink(rows[0]!.testid, rows[0]!.name)
    expect(document.activeElement, 'precondition: j focused the first link').toBe(link)
    await user.keyboard('x')

    expect(document.activeElement).toBe(link)
    expect(shell.path()).toBe(path)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // Kills: a row link out of the Tab order, or named by something other than the record's name (or email).
  it(`AC-7: Tab reaches every row’s link, in row order, each named by the record`, async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell(path)
    await screen.findByTestId(rows[0]!.testid)
    const links = rows.map((r) => rowLink(r.testid, r.name))
    screen.getByLabelText(search).focus()

    // Each link's first visit, until all are reached: a Tab past the end wraps through the shell.
    const reached: Element[] = []
    for (let i = 0; i < rows.length * 3 + 6 && reached.length < links.length; i += 1) {
      await user.tab()
      const at = document.activeElement
      if (at && links.includes(at as HTMLElement) && !reached.includes(at)) reached.push(at)
    }
    expect(reached).toEqual(links)
  })

  // Kills: the row's own click handler hijacking a Ctrl-click on the link; the rest of the row no longer opening it.
  it(`AC-7: a Ctrl-click on a row’s link leaves the URL unchanged; a click elsewhere on the row opens the record`, async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell(path)
    await screen.findByTestId(rows[1]!.testid)

    await ctrlClick(user, rowLink(rows[1]!.testid, rows[1]!.name))
    expect(shell.path(), 'after a Ctrl-click').toBe(path)

    await user.click(otherCell(screen.getByTestId(rows[1]!.testid)))
    await waitFor(() => expect(shell.path()).toBe(rows[1]!.opens))
  })
})
