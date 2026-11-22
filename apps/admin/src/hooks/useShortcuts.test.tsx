import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SHORTCUTS, type Shortcut } from '@/lib/shortcuts'
import { fakeShellApi, inventoryRow, product, renderAdminShell } from '@/tests/admin-shell'
import { orderIn, polyfillRadix } from '@/tests/order-page'

// The keyboard shortcuts in the signed-in shell (the layout and the real list pages, fetch stubbed): where each key
// takes the merchant, and the places it must leave alone, a field they type in, an open menu or dialog, a held Ctrl.

/** This file's own copy of the go-to map. */
const GO_TO: Array<[letter: string, path: string]> = [
  ['d', '/'],
  ['o', '/orders'],
  ['p', '/products'],
  ['i', '/inventory'],
  ['c', '/customers'],
  ['r', '/reports'],
  ['a', '/activity'],
  ['n', '/inbox'],
  ['s', '/settings'],
]

const ORDERS = [
  orderIn('confirmed', { id: 'o-1', orderNumber: 'NYM-1001' }),
  orderIn('pending', { id: 'o-2', orderNumber: 'NYM-1002' }),
]
const PRODUCTS = [product('p-1', 'Linen Shirt', 'linen-shirt')]

function seed() {
  return fakeShellApi({ orders: ORDERS, products: PRODUCTS, inventory: [inventoryRow(1)] })
}

/** Presses `g` then the letter, as two key strokes. */
const go = (user: ReturnType<typeof userEvent.setup>, letter: string) => user.keyboard(`g${letter}`)

const helpDialog = () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })

/** Dispatches one keydown at the focused element and says whether the page prevented its default. */
function pressPrevented(key: string): boolean {
  const target = document.activeElement ?? document.body
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('go-to shortcuts', () => {
  // Kills: a pair missing or pointing at another page; the dispatcher not mounted in the layout.
  it('AC-3: g then each of the nine letters navigates to its page', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/settings')
    await screen.findByRole('heading', { name: 'Settings' })

    const visited: string[] = []
    for (const [letter, path] of GO_TO) {
      const before = shell.path()
      await go(user, letter)
      await waitFor(() => expect(shell.path(), `g ${letter}`).toBe(path))
      expect(shell.path(), `g ${letter} moved off ${before}`).not.toBe(before)
      visited.push(shell.path())
    }
    expect(visited).toEqual(GO_TO.map(([, path]) => path))
  })

  // Kills: the prefix never expiring, so a stray g makes a later letter navigate.
  it('AC-3: g, 1600 ms, then o does not navigate; g o at once does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true })
    seed()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const shell = renderAdminShell('/')
    await screen.findByTestId('admin-nav-orders')

    await user.keyboard('g')
    await act(() => vi.advanceTimersByTimeAsync(1600))
    await user.keyboard('o')
    expect(shell.path(), 'the prefix expired').toBe('/')

    await go(user, 'o')
    await waitFor(() => expect(shell.path()).toBe('/orders'))
  })

  // Kills: a shortcut read inside a text field (a typed "gp" leaves the page, `/` is swallowed, `j` moves focus, `x`
  // selects, `?` opens the help).
  it('AC-3: typed into the orders search, g p g o / j x ? are only text and nothing else changes', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')

    const field = screen.getByLabelText('Search orders')
    await user.click(field)
    await user.keyboard('gpgo/jx?')

    expect(field).toHaveValue('gpgo/jx?')
    expect(document.activeElement).toBe(field)
    expect(shell.path()).toBe('/orders')
    expect(helpDialog()).toBeNull()
    expect(screen.queryByTestId('admin-orders-bulk-bar')).toBeNull()
  })

  // Kills: a shortcut fired from inside, or while there is, an open dialog or menu.
  it('AC-3: with the palette, a row menu or the help open, g o does nothing; closed, it navigates', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/products')
    const row = await screen.findByTestId('admin-products-row-p-1')

    await user.keyboard('{Control>}k{/Control}')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await go(user, 'o')
    expect(shell.path(), 'palette open').toBe('/products')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(within(row).getByRole('button'))
    const menu = await screen.findByRole('menu')
    await go(user, 'o')
    expect(shell.path(), 'menu open').toBe('/products')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(menu).not.toBeInTheDocument())

    await user.keyboard('?')
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    await go(user, 'o')
    expect(shell.path(), 'help open').toBe('/products')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(helpDialog()).toBeNull())

    await go(user, 'o')
    await waitFor(() => expect(shell.path()).toBe('/orders'))
  })

  // Kills: a browser or OS shortcut (Ctrl-G, Ctrl-O) read as a go-to.
  it('AC-3: with Ctrl held, g o does nothing; without it, it navigates', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/')
    await screen.findByTestId('admin-nav-orders')

    await user.keyboard('{Control>}go{/Control}')
    expect(shell.path(), 'with Ctrl').toBe('/')

    await go(user, 'o')
    await waitFor(() => expect(shell.path()).toBe('/orders'))
  })

  // Kills: every completed key swallowed, even where it did nothing (a `/` on a page with no search field).
  it('AC-3: / and j on the dashboard leave the key’s default alone; / on the orders page, where it focuses the search, prevents it', async () => {
    seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/')
    await screen.findByTestId('admin-nav-orders')

    const onDashboard = { slash: pressPrevented('/'), j: pressPrevented('j') }

    await go(user, 'o')
    await waitFor(() => expect(shell.path()).toBe('/orders'))
    await screen.findByTestId('admin-orders-row-NYM-1001')
    const onOrders = pressPrevented('/')

    expect(onDashboard).toEqual({ slash: false, j: false })
    expect(onOrders, 'prevented only where the command acted').not.toBe(onDashboard.slash)
    expect(document.activeElement).toBe(screen.getByLabelText('Search orders'))
  })
})

describe('the shortcut help', () => {
  // Kills: no help, a help that lists a different set from the table, focus lost on close.
  it('AC-4: ? opens "Keyboard shortcuts" listing every shortcut, focus inside; Escape closes it and focus returns', async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell('/orders')
    await screen.findByTestId('admin-orders-row-NYM-1001')
    const chip = screen.getByRole('button', { name: 'Pending' })
    chip.focus()

    await user.keyboard('?')
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    const missing = SHORTCUTS.filter(
      (s: Shortcut) => within(dialog).queryAllByText(s.label).length === 0,
    )
    expect(
      missing.map((s: Shortcut) => s.label),
      'labels not shown',
    ).toEqual([])
    const escapeEntries = SHORTCUTS.filter(
      (s: Shortcut) => !s.command && s.keys.some((k: string) => /^esc/i.test(k)),
    )
    expect(escapeEntries.length, 'Escape (leave the search field) is listed').toBe(1)
    expect(dialog.contains(document.activeElement), 'focus inside the help').toBe(true)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(helpDialog()).toBeNull())
    expect(document.activeElement).toBe(chip)
  })

  // Kills: the help opening over a field the merchant is typing in.
  it('AC-4: ? typed in a text field is text and opens nothing', async () => {
    seed()
    const user = userEvent.setup()
    renderAdminShell('/products')
    await screen.findByTestId('admin-products-row-p-1')

    const field = screen.getByLabelText('Search products')
    await user.click(field)
    await user.keyboard('?')

    expect(field).toHaveValue('?')
    expect(helpDialog()).toBeNull()
    expect(document.activeElement).toBe(field)

    // Out of the field, the same key opens the help.
    await user.keyboard('{Escape}?')
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(field).toHaveValue('?')
  })
})
