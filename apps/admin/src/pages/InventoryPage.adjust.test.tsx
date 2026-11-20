import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/tests/render'
import type { InventoryRow } from '@/types'
import { InventoryPage } from './InventoryPage'

// A row's Apply on the inventory page against a fake admin API (fetch stubbed): `GET /api/admin/inventory` serves the
// committed stock, and each adjust POST is answered as the test says, at once or when the test releases it.

const AT = '2026-11-19T10:00:00.000Z'
const REFUSAL = 'Cannot reduce stock below zero (variant v-a)'
const FALLBACK = 'The stock could not be changed.'

type Outcome = 'refused' | 'throws' | 'applied'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function row(variantId: string, stock: number): InventoryRow {
  return {
    variantId,
    productId: `p-${variantId}`,
    productName: `Product ${variantId}`,
    sku: `SKU-${variantId}`,
    options: [],
    stock,
    threshold: 1,
    status: stock <= 0 ? 'out_of_stock' : stock <= 1 ? 'low_stock' : 'in_stock',
    updatedAt: AT,
  }
}

/** The API with one adjust outcome per POST, in order; while `holding`, each answer waits for `release`. */
function fakeApi(rows: InventoryRow[], outcomes: Outcome[], opts: { holding?: boolean } = {}) {
  const committed = new Map(rows.map((r) => [r.variantId, r.stock]))
  const posts: Array<{ variantId: string; delta: number }> = []
  const held: Array<() => void> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && url.pathname === '/api/admin/inventory') {
      return json({ data: rows.map((r) => row(r.variantId, committed.get(r.variantId)!)) })
    }
    const adjust = /^\/api\/admin\/inventory\/([^/]+)\/adjust$/.exec(url.pathname)
    if (method === 'POST' && adjust) {
      const variantId = adjust[1]!
      const { delta } = JSON.parse(String(init.body)) as { delta: number }
      const outcome = outcomes[posts.length] ?? 'applied'
      posts.push({ variantId, delta })
      if (opts.holding) await new Promise<void>((resolve) => held.push(resolve))
      if (outcome === 'throws') throw new TypeError('Failed to fetch')
      if (outcome === 'refused') {
        return json({ error: { code: 'validation.failed', message: REFUSAL } }, 400)
      }
      committed.set(variantId, committed.get(variantId)! + delta)
      return json({ data: { newQty: committed.get(variantId), variantId } })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return { posts, release: () => held.splice(0).forEach((open) => open()) }
}

/** Every unhandled rejection raised while the test runs. */
function unhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = []
  const record = (reason: unknown) => void reasons.push(reason)
  process.on('unhandledRejection', record)
  return { reasons, stop: () => void process.off('unhandledRejection', record) }
}

/** Whether `el` ever read "Done" from now on, across every re-render. */
function watchDone(el: HTMLElement): () => boolean {
  let seen = false
  const check = () => {
    if (el.textContent?.includes('Done')) seen = true
  }
  new MutationObserver(check).observe(el, { subtree: true, childList: true, characterData: true })
  return () => {
    check()
    return seen
  }
}

/** One event-loop turn: an unhandled rejection is reported by then. */
const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function adjustRow(variantId: string) {
  const adjust = await screen.findByTestId(`admin-inventory-adjust-${variantId}`, undefined, {
    timeout: 5000,
  })
  return {
    adjust,
    field: () => within(adjust).getByRole('spinbutton'),
    setDelta: (n: number) =>
      fireEvent.change(within(adjust).getByRole('spinbutton'), { target: { value: String(n) } }),
    apply: () => within(adjust).getByRole('button', { name: 'Apply' }),
    error: () => screen.queryByTestId(`admin-inventory-adjust-error-${variantId}`),
  }
}

/** The row's Stock column, as a number. */
function stockShown(variantId: string): number {
  const column = screen
    .getAllByRole('columnheader')
    .findIndex((header) => header.textContent?.trim() === 'Stock')
  const cells = within(screen.getByTestId(`admin-inventory-row-${variantId}`)).getAllByRole('cell')
  return Number(cells[column]!.textContent)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-8: a refused adjustment says why and never Done', () => {
  it('AC-8: a 400 validation.failed shows its message in the row error, never reads Done, keeps the delta typed and the stock, enables Apply again and raises no unhandled rejection', async () => {
    const rejections = unhandledRejections()
    const api = fakeApi([row('v-a', 3), row('v-b', 10)], ['refused'])
    renderWithProviders(<InventoryPage />)
    const a = await adjustRow('v-a')
    const stockBefore = stockShown('v-a')
    const everDone = watchDone(a.adjust)

    a.setDelta(-5)
    fireEvent.click(a.apply())

    const error = await screen.findByTestId('admin-inventory-adjust-error-v-a')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent(REFUSAL)
    await aTurn()
    await aTurn()
    rejections.stop()

    expect(api.posts).toEqual([{ variantId: 'v-a', delta: -5 }])
    expect(everDone(), 'the button read Done').toBe(false)
    expect(a.field()).toHaveValue(-5)
    expect(a.apply()).toBeEnabled()
    expect(stockShown('v-a'), 'the stock shown after the refusal').toBe(stockBefore)
    expect(rejections.reasons.map(String), 'unhandled rejections').toEqual([])
  })

  it('AC-8: a rejection that is not an ApiError (fetch throws a TypeError) shows "The stock could not be changed." and never Done', async () => {
    const rejections = unhandledRejections()
    fakeApi([row('v-a', 3)], ['throws'])
    renderWithProviders(<InventoryPage />)
    const a = await adjustRow('v-a')
    const everDone = watchDone(a.adjust)

    a.setDelta(2)
    fireEvent.click(a.apply())

    const error = await screen.findByTestId('admin-inventory-adjust-error-v-a')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent(FALLBACK)
    await aTurn()
    await aTurn()
    rejections.stop()

    expect(everDone(), 'the button read Done').toBe(false)
    expect(a.field()).toHaveValue(2)
    expect(a.apply()).toBeEnabled()
    expect(rejections.reasons.map(String), 'unhandled rejections').toEqual([])
  })
})

describe('AC-9: Apply is one adjustment, shown at once and confirmed by the answer', () => {
  it('AC-9: while the POST is held the row already reads before + delta and Apply is disabled under its name, a second click sends nothing; on the answer the button reads Done and the field resets to 0', async () => {
    const api = fakeApi([row('v-a', 10), row('v-b', 4)], ['applied'], { holding: true })
    renderWithProviders(<InventoryPage />)
    const a = await adjustRow('v-a')
    const before = stockShown('v-a')
    const delta = 3

    a.setDelta(delta)
    fireEvent.click(a.apply())
    await waitFor(() => expect(api.posts.length, 'POSTs sent').toBe(1))

    await waitFor(() => expect(stockShown('v-a'), 'the stock while held').toBe(before + delta))
    expect(a.apply(), 'Apply while the POST is held').toBeDisabled()
    expect(a.adjust, 'Done before the answer').not.toHaveTextContent('Done')
    act(() => {
      a.apply().click()
    })
    fireEvent.click(a.apply())
    await aTurn()
    expect(api.posts.length, 'POSTs after a second click while held').toBe(1)

    api.release()
    await waitFor(() => expect(a.adjust).toHaveTextContent('Done'))
    expect(a.field()).toHaveValue(0)
    expect(stockShown('v-a'), 'the stock after the answer').toBe(before + delta)
  })

  it('AC-9: the next Apply after a refusal clears the error, and its answer reads Done with the new stock', async () => {
    const api = fakeApi([row('v-a', 10)], ['refused', 'applied'])
    renderWithProviders(<InventoryPage />)
    const a = await adjustRow('v-a')
    const before = stockShown('v-a')

    a.setDelta(-20)
    fireEvent.click(a.apply())
    await screen.findByTestId('admin-inventory-adjust-error-v-a')

    a.setDelta(2)
    fireEvent.click(a.apply())
    await waitFor(() => expect(api.posts.length).toBe(2))
    await waitFor(() => expect(a.error(), 'the refusal after the next Apply').toBeNull())
    await waitFor(() => expect(a.adjust).toHaveTextContent('Done'))
    expect(stockShown('v-a'), 'the stock after the applied adjust').toBe(before + 2)
  })
})
