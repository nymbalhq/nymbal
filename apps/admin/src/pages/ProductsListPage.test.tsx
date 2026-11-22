import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProductSnapshot, ProductStatus } from '@nymbalhq/types'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { ProductsListPage } from './ProductsListPage'

// The products list's row menu against a fake admin API (fetch stubbed): `GET /api/admin/products` serves the stored
// products, and each Duplicate or Archive POST is answered as the test says, at once or when the test releases it.

const AT = '2026-11-19T10:00:00.000Z'
const REFUSAL = 'Product slug already exists: linen-shirt-copy'
const ARCHIVE_REFUSAL = 'Product cannot be archived while an import runs'

type Action = 'duplicate' | 'archive'
type Outcome = 'ok' | 'refused' | 'throws'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function product(id: string, name: string, status: ProductStatus = 'active'): ProductSnapshot {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    description: '',
    shortDescription: '',
    status,
    type: 'simple',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
    categoryIds: [],
    variants: [
      {
        id: `${id}-v`,
        productId: id,
        sku: `${id.toUpperCase()}-1`,
        name: 'Default',
        priceMinor: 2500,
        compareAtPriceMinor: null,
        weightGrams: null,
        dimensions: null,
        stock: 4,
        lowStockThreshold: 1,
        options: [],
        status: 'active',
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  }
}

/**
 * The API: one outcome per POST in order (then 'ok'); while `holding`, each POST's answer waits until the test
 * releases that product's action. A duplicate's copy is answered but never listed, as when the list's 100 rows are
 * older products.
 */
function fakeApi(
  products: ProductSnapshot[],
  outcomes: Outcome[] = [],
  opts: { holding?: boolean } = {},
) {
  const stored = new Map(products.map((p) => [p.id, p]))
  const posts: Array<{ action: Action; id: string }> = []
  const copies: ProductSnapshot[] = []
  const held = new Map<string, Array<() => void>>()
  let gets = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && url.pathname === '/api/admin/products') {
      gets += 1
      return json({ data: [...stored.values()], meta: { total: stored.size } })
    }
    const write = /^\/api\/admin\/products\/([^/]+)\/(duplicate|archive)$/.exec(url.pathname)
    if (method === 'POST' && write) {
      const id = write[1]!
      const action = write[2] as Action
      const outcome = outcomes[posts.length] ?? 'ok'
      posts.push({ action, id })
      if (opts.holding) {
        await new Promise<void>((resolve) => {
          const key = `${action}:${id}`
          held.set(key, [...(held.get(key) ?? []), resolve])
        })
      }
      if (outcome === 'throws') throw new TypeError('Failed to fetch')
      if (outcome === 'refused') {
        const message = action === 'duplicate' ? REFUSAL : ARCHIVE_REFUSAL
        return json({ error: { code: 'validation.failed', message } }, 400)
      }
      const original = stored.get(id)!
      if (action === 'archive') {
        const archived = { ...original, status: 'archived' as const }
        stored.set(id, archived)
        return json({ data: archived })
      }
      const copy = {
        ...original,
        id: `${id}-copy-${copies.length + 1}`,
        slug: `${original.slug}-copy${copies.length === 0 ? '' : `-${copies.length + 1}`}`,
        name: `${original.name} (Copy)`,
        status: 'draft' as const,
      }
      copies.push(copy)
      return json({ data: copy }, 201)
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return {
    posts,
    copies,
    gets: () => gets,
    postsFor: (action: Action, id: string) =>
      posts.filter((p) => p.action === action && p.id === id).length,
    release: (action: Action, id: string) => {
      const key = `${action}:${id}`
      held
        .get(key)
        ?.splice(0)
        .forEach((open) => open())
    },
  }
}

/** Every unhandled rejection raised while the test runs. */
function unhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = []
  const record = (reason: unknown) => void reasons.push(reason)
  process.on('unhandledRejection', record)
  return { reasons, stop: () => void process.off('unhandledRejection', record) }
}

/** One event-loop turn: an unhandled rejection is reported by then. */
const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function OpenedProduct() {
  const { slug } = useParams()
  return <p data-testid="opened-product">{slug}</p>
}

function renderList() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<ProductsListPage />} />
      <Route path="/products/:slug" element={<OpenedProduct />} />
    </Routes>,
  )
}

type User = ReturnType<typeof userEvent.setup>

async function openMenu(user: User, p: ProductSnapshot) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${p.name}` }))
  await screen.findByRole('menu')
}

async function closeMenu(user: User) {
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
}

async function choose(user: User, action: Action | 'edit', p: ProductSnapshot) {
  await openMenu(user, p)
  await user.click(await screen.findByTestId(`admin-products-row-${action}-${p.id}`))
}

const menuItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())

/** The row's Status cell text, as rendered (its capital is CSS). */
function statusShown(id: string): string {
  const column = screen
    .getAllByRole('columnheader')
    .findIndex((header) => header.textContent?.trim() === 'Status')
  const cells = within(screen.getByTestId(`admin-products-row-${id}`)).getAllByRole('cell')
  return cells[column]!.textContent!.trim()
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

const SHIRT = product('p-shirt', 'Linen Shirt')
const MUG = product('p-mug', 'Stone Mug')
const LAMP = product('p-lamp', 'Brass Lamp', 'draft')
const OLD = product('p-old', 'Old Scarf', 'archived')

describe('the products row menu: Duplicate', () => {
  it('AC-2: Duplicate sends one POST; on 201 the result line reads "Duplicated as <copy name>", the list is refetched, and the name links to /products/<copy slug> though the copy is not on the page', async () => {
    const api = fakeApi([SHIRT, MUG])
    const user = userEvent.setup()
    renderList()
    await screen.findByTestId(`admin-products-row-${SHIRT.id}`)
    const getsBefore = api.gets()

    await choose(user, 'duplicate', SHIRT)

    const result = await screen.findByTestId('admin-products-row-result')
    const copy = api.copies[0]!
    await waitFor(() => expect(result).toHaveTextContent(`Duplicated as ${copy.name}`))
    expect(result.getAttribute('role')).toBe('status')
    expect(api.posts).toEqual([{ action: 'duplicate', id: SHIRT.id }])
    await waitFor(() => expect(api.gets(), 'the list is refetched').toBeGreaterThan(getsBefore))
    expect(
      screen.queryByTestId(`admin-products-row-${copy.id}`),
      'the copy is not listed',
    ).toBeNull()

    await user.click(within(result).getByTestId('admin-products-row-result-link'))
    expect((await screen.findByTestId('opened-product')).textContent).toBe(copy.slug)
  })

  it('AC-2: a 400 shows its message in the alert and a rejection that is not an API error reads "The product could not be duplicated.", each replacing the last, with no unhandled rejection', async () => {
    const rejections = unhandledRejections()
    try {
      const api = fakeApi([SHIRT, MUG], ['refused', 'throws'])
      const user = userEvent.setup()
      renderList()
      await screen.findByTestId(`admin-products-row-${SHIRT.id}`)

      await choose(user, 'duplicate', SHIRT)
      const refused = await screen.findByTestId('admin-products-row-error')
      await waitFor(() => expect(refused.textContent?.trim()).toBe(REFUSAL))
      expect(refused.getAttribute('role')).toBe('alert')
      expect(screen.queryByTestId('admin-products-row-result')).toBeNull()

      await choose(user, 'duplicate', MUG)
      await waitFor(() =>
        expect(screen.getByTestId('admin-products-row-error').textContent?.trim()).toBe(
          'The product could not be duplicated.',
        ),
      )
      expect(api.posts).toEqual([
        { action: 'duplicate', id: SHIRT.id },
        { action: 'duplicate', id: MUG.id },
      ])
      await aTurn()
      expect(rejections.reasons).toEqual([])
    } finally {
      rejections.stop()
    }
  })
})

describe('the products row menu: one POST per choice', () => {
  it('AC-3: while a duplicate is in flight its item is disabled and choosing it sends nothing; a Duplicate on another product sends its own POST and leaves the first disabled, before and after the second ends', async () => {
    const api = fakeApi([SHIRT, MUG], [], { holding: true })
    const user = userEvent.setup()
    renderList()
    await screen.findByTestId(`admin-products-row-${SHIRT.id}`)

    await choose(user, 'duplicate', SHIRT)
    await waitFor(() => expect(api.postsFor('duplicate', SHIRT.id)).toBe(1))

    await openMenu(user, SHIRT)
    const again = screen.getByTestId(`admin-products-row-duplicate-${SHIRT.id}`)
    expect(again).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(again)
    await closeMenu(user)
    expect(api.postsFor('duplicate', SHIRT.id), 'a choice while in flight').toBe(1)

    await openMenu(user, MUG)
    const other = screen.getByTestId(`admin-products-row-duplicate-${MUG.id}`)
    expect(other).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(other)
    await waitFor(() => expect(api.postsFor('duplicate', MUG.id)).toBe(1))

    await openMenu(user, SHIRT)
    expect(
      screen.getByTestId(`admin-products-row-duplicate-${SHIRT.id}`),
      'the first while the second is in flight',
    ).toHaveAttribute('aria-disabled', 'true')
    await closeMenu(user)

    api.release('duplicate', MUG.id)
    await waitFor(() =>
      expect(screen.getByTestId('admin-products-row-result')).toHaveTextContent(
        `Duplicated as ${MUG.name} (Copy)`,
      ),
    )
    await openMenu(user, SHIRT)
    const afterOther = screen.getByTestId(`admin-products-row-duplicate-${SHIRT.id}`)
    expect(afterOther, 'the first after the second ended').toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(afterOther)
    await closeMenu(user)

    api.release('duplicate', SHIRT.id)
    await waitFor(() =>
      expect(screen.getByTestId('admin-products-row-result')).toHaveTextContent(
        `Duplicated as ${SHIRT.name} (Copy)`,
      ),
    )
    expect(api.posts.length, 'one POST per product').toBe(api.copies.length)
    expect(api.posts.filter((p) => p.id === SHIRT.id).length).toBe(1)
  }, 20_000)

  it('AC-3: while an archive is in flight its item is disabled and choosing it sends nothing', async () => {
    const api = fakeApi([SHIRT, MUG], [], { holding: true })
    const user = userEvent.setup()
    renderList()
    await screen.findByTestId(`admin-products-row-${SHIRT.id}`)

    await choose(user, 'archive', SHIRT)
    await waitFor(() => expect(api.postsFor('archive', SHIRT.id)).toBe(1))

    await openMenu(user, SHIRT)
    const again = screen.getByTestId(`admin-products-row-archive-${SHIRT.id}`)
    expect(again).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(again)
    await closeMenu(user)

    api.release('archive', SHIRT.id)
    await waitFor(() =>
      expect(screen.getByTestId('admin-products-row-result')).toHaveTextContent(
        `Archived ${SHIRT.name}`,
      ),
    )
    expect(api.posts).toEqual([{ action: 'archive', id: SHIRT.id }])
  })
})

describe('the products row menu: Archive', () => {
  it('AC-4: Archive on an active and on a draft product sends one POST each, reads "Archived <name>", and the row\'s status reads archived after the refetch', async () => {
    const api = fakeApi([SHIRT, LAMP])
    const user = userEvent.setup()
    renderList()
    await screen.findByTestId(`admin-products-row-${SHIRT.id}`)

    for (const p of [SHIRT, LAMP]) {
      const before = statusShown(p.id)
      expect(before.toLowerCase(), `${p.name} before`).toBe(p.status)

      await choose(user, 'archive', p)

      await waitFor(() =>
        expect(screen.getByTestId('admin-products-row-result')).toHaveTextContent(
          `Archived ${p.name}`,
        ),
      )
      await waitFor(() => expect(statusShown(p.id)).toMatch(/^archived$/i))
      expect(statusShown(p.id), `${p.name} after`).not.toBe(before)
      expect(api.postsFor('archive', p.id), p.name).toBe(1)
    }
    expect(api.posts.length).toBe(2)
  }, 20_000)

  it("AC-4: a refused archive shows the store's message in the alert and leaves the row's status; the next action clears the alert", async () => {
    const rejections = unhandledRejections()
    try {
      const api = fakeApi([SHIRT, LAMP], ['refused'])
      const user = userEvent.setup()
      renderList()
      await screen.findByTestId(`admin-products-row-${SHIRT.id}`)
      const before = statusShown(SHIRT.id)

      await choose(user, 'archive', SHIRT)
      const alert = await screen.findByTestId('admin-products-row-error')
      await waitFor(() => expect(alert.textContent?.trim()).toBe(ARCHIVE_REFUSAL))
      expect(alert.getAttribute('role')).toBe('alert')
      expect(statusShown(SHIRT.id)).toBe(before)

      await choose(user, 'archive', LAMP)
      await waitFor(() =>
        expect(screen.getByTestId('admin-products-row-result')).toHaveTextContent(
          `Archived ${LAMP.name}`,
        ),
      )
      expect(screen.queryByTestId('admin-products-row-error')).toBeNull()
      expect(api.posts.length).toBe(2)
      await aTurn()
      expect(rejections.reasons).toEqual([])
    } finally {
      rejections.stop()
    }
  })

  it("AC-4: an archived product's menu offers Edit and Duplicate and no Archive", async () => {
    fakeApi([SHIRT, OLD])
    const user = userEvent.setup()
    renderList()
    await screen.findByTestId(`admin-products-row-${OLD.id}`)

    await openMenu(user, OLD)

    expect(menuItems()).toEqual(['Edit', 'Duplicate'])
    expect(screen.queryByTestId(`admin-products-row-archive-${OLD.id}`)).toBeNull()
  })
})

describe('the products row menu: by keyboard', () => {
  it('AC-5: the row trigger is the button "Actions for <name>", and Enter or Space on it opens a menu of Edit, Duplicate and Archive', async () => {
    fakeApi([SHIRT, MUG])
    const user = userEvent.setup()
    renderList()
    await screen.findByTestId(`admin-products-row-${SHIRT.id}`)
    const trigger = screen.getByRole('button', { name: `Actions for ${SHIRT.name}` })
    expect(trigger.getAttribute('data-testid')).toBe(`admin-products-row-actions-${SHIRT.id}`)

    for (const key of ['{Enter}', ' ']) {
      trigger.focus()
      await user.keyboard(key)
      await screen.findByRole('menu')
      expect(menuItems(), key).toEqual(['Edit', 'Duplicate', 'Archive'])
      await closeMenu(user)
    }
  })
})
