import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CommandPalette, CommandPaletteButton } from '@/components/common/CommandPalette'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'

// The palette in the top bar against a fake search API (fetch stubbed): what the server returns is what is shown,
// and the pages it goes to by keyboard alone.

const FIELD = { name: 'Search or run a command' }

/** The palette's pages, in any order. */
const TEN = [
  'Go to Dashboard',
  'Go to Orders',
  'Go to Products',
  'Go to Inventory',
  'Go to Customers',
  'Go to Reports',
  'Go to Activity',
  'Go to Inbox',
  'Go to Settings',
  'New product',
]

const DESTINATION: Record<string, string> = {
  'Go to Dashboard': '/',
  'Go to Orders': '/orders',
  'Go to Products': '/products',
  'Go to Inventory': '/inventory',
  'Go to Customers': '/customers',
  'Go to Reports': '/reports',
  'Go to Activity': '/activity',
  'Go to Inbox': '/inbox',
  'Go to Settings': '/settings',
  'New product': '/products/new',
}

const SHIRT = {
  id: '0190f5d2-7c3e-7a41-9b2d-5e8f3a6c1d24',
  slug: 'linen-shirt',
  name: 'Linen Shirt',
  status: 'active',
}
const JANE = {
  id: '0190f5d3-1a2b-7c4d-8e5f-60718293a4b5',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
}
const ORDER = { id: 'o-1042', orderNumber: '1042', email: 'jane@example.com', status: 'confirmed' }

interface SearchAnswer {
  orders: unknown[]
  products: unknown[]
  customers: unknown[]
}

/** The search route as the server matches: a product by name, a customer by name, an order by email. */
function serverMatch(q: string): SearchAnswer {
  const s = q.toLowerCase()
  return {
    orders: ORDER.email.includes(s) ? [ORDER] : [],
    products: SHIRT.name.toLowerCase().includes(s) ? [SHIRT] : [],
    customers: `${JANE.firstName} ${JANE.lastName}`.toLowerCase().includes(s) ? [JANE] : [],
  }
}

function fakeSearchApi() {
  const searches: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname === '/api/admin/search') {
      const q = url.searchParams.get('q') ?? ''
      searches.push(q)
      return json({ data: serverMatch(q) })
    }
    return json({ data: {} })
  })
  return { searches }
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

function renderPalette(initialPath = '/orders') {
  return renderWithProviders(
    <>
      <CommandPaletteButton />
      <CommandPalette />
      <Where />
    </>,
    { initialPath },
  )
}

const openPalette = (user: ReturnType<typeof userEvent.setup>) =>
  user.keyboard('{Control>}k{/Control}')
const optionNames = (group: HTMLElement) =>
  within(group)
    .getAllByRole('option')
    .map((o) => o.textContent?.trim() ?? '')

/** Moves the highlight down until `option` holds it (a list of a few entries; bounded). */
async function highlight(user: ReturnType<typeof userEvent.setup>, option: HTMLElement) {
  for (let i = 0; i < 12 && option.getAttribute('aria-selected') !== 'true'; i += 1) {
    await user.keyboard('{ArrowDown}')
  }
  expect(option, 'the result to choose holds the highlight').toHaveAttribute(
    'aria-selected',
    'true',
  )
}

beforeAll(polyfillRadix)

afterEach(() => {
  act(() => useCommandPalette.getState().close())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the palette shows what the server found', () => {
  // Kills: cmdk's own filter left on, scoring `product-<id>` and `customer-<id>` against a typed name and hiding
  // results the server returned.
  it('AC-3: a product found by name, and a customer and an order found by a name in their email, are shown as the server returned them; Enter on the product opens its page and closes the palette', async () => {
    const api = fakeSearchApi()
    const user = userEvent.setup()
    renderPalette()
    await openPalette(user)
    const field = await screen.findByRole('combobox')

    await user.type(field, 'jane')
    const customers = await screen.findByRole('group', { name: 'Customers' }, { timeout: 3000 })
    const orders = screen.getByRole('group', { name: 'Orders' })
    const answer = serverMatch('jane')
    expect(within(customers).getAllByRole('option')).toHaveLength(answer.customers.length)
    expect(within(orders).getAllByRole('option')).toHaveLength(answer.orders.length)
    expect(within(customers).getByRole('option')).toHaveTextContent(
      `${JANE.firstName} ${JANE.lastName}`,
    )
    expect(within(orders).getByRole('option')).toHaveTextContent(`#${ORDER.orderNumber}`)
    expect(within(orders).getByRole('option')).toHaveTextContent(ORDER.email)

    await user.clear(field)
    await user.type(field, 'shirt')
    const products = await screen.findByRole('group', { name: 'Products' }, { timeout: 3000 })
    expect(within(products).getAllByRole('option')).toHaveLength(
      serverMatch('shirt').products.length,
    )
    const shirt = within(products).getByRole('option')
    expect(shirt).toHaveTextContent(SHIRT.name)
    expect(api.searches, 'the queries the server matched').toEqual(
      expect.arrayContaining(['jane', 'shirt']),
    )

    await highlight(user, shirt)
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`/products/${SHIRT.slug}`),
    )
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('the palette goes to a page by keyboard', () => {
  // Kills: no navigation commands; a fuzzy or unfocused field; Enter that selects nothing; the palette left open over
  // the new page; a reopen that shows the last search; a search sent for one character.
  it('AC-4: the named field lists the ten pages; "inv" leaves Go to Inventory highlighted first; Enter opens /inventory and closes the palette; reopened, it is empty with all ten; no search is sent under two characters', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = fakeSearchApi()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) })
    renderPalette('/orders')

    await openPalette(user)
    const field = await screen.findByRole('combobox', FIELD)
    expect(field, 'the field takes the keyboard when the palette opens').toHaveFocus()
    const goTo = screen.getByRole('group', { name: 'Go to' })
    expect([...optionNames(goTo)].sort()).toEqual([...TEN].sort())

    await user.keyboard('i')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(api.searches, 'searches sent for one character').toEqual([])

    await user.keyboard('nv')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    await waitFor(() => expect(api.searches).toEqual(['inv']))
    const kept = within(screen.getByRole('group', { name: 'Go to' })).getAllByRole('option')
    expect(kept.map((o) => o.textContent?.trim())).toEqual(['Go to Inventory'])
    expect(screen.getAllByRole('option')[0], 'the first option of the palette').toBe(kept[0])
    expect(kept[0]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/inventory$/))
    expect(screen.queryByRole('combobox', FIELD)).not.toBeInTheDocument()

    await openPalette(user)
    const reopened = await screen.findByRole('combobox', FIELD)
    expect(reopened).toHaveValue('')
    expect([...optionNames(screen.getByRole('group', { name: 'Go to' }))].sort()).toEqual(
      [...TEN].sort(),
    )
    expect(
      api.searches.every((q) => q.length >= 2),
      `searches ${JSON.stringify(api.searches)}`,
    ).toBe(true)
  })

  it('AC-4: every navigation command opens its page and closes the palette', async () => {
    fakeSearchApi()
    const user = userEvent.setup()
    renderPalette('/settings')
    const reached: Record<string, string> = {}

    for (const label of TEN) {
      await openPalette(user)
      const goTo = await screen.findByRole('group', { name: 'Go to' })
      await user.click(within(goTo).getByRole('option', { name: label }))
      await waitFor(() => expect(screen.queryByRole('combobox', FIELD)).not.toBeInTheDocument())
      reached[label] = screen.getByTestId('where').textContent ?? ''
    }

    expect(reached).toEqual(DESTINATION)
  })
})
