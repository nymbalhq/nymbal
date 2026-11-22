import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import { fakeShellApi, renderAdminShell, type Shell, type ShellApi } from '@/tests/admin-shell'
import { polyfillRadix } from '@/tests/order-page'

// The product page's unsaved edit in the signed-in shell, with the real sidebar, `g` shortcuts and palette, against a
// fake admin API (fetch stubbed): every way out inside the admin asks "Leave without saving?" while "Unsaved changes"
// shows, Stay keeps the edit where it was, Leave goes where the merchant asked; nothing asks on a clean form, after a
// finished save, on signing out or on a lost session; a reload or a tab close asks the browser to confirm.

type User = ReturnType<typeof userEvent.setup>

const AT = '2026-11-22T10:00:00.000Z'

function variant(productId: string, i: number): Variant {
  return {
    id: `${productId}-var-${i}`,
    productId,
    sku: `${productId.toUpperCase()}-${i}`,
    name: `Size ${i}`,
    priceMinor: 2500 + 100 * i,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: 5 + i,
    lowStockThreshold: 2,
    options: [{ name: 'Size', value: `S${i}` }],
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  }
}

function product(id: string, slug: string, name: string, description: string): ProductSnapshot {
  return {
    id,
    slug,
    name,
    description,
    shortDescription: '',
    status: 'active',
    type: 'variable',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    categoryIds: [],
    createdAt: AT,
    updatedAt: AT,
    variants: [variant(id, 0), variant(id, 1)],
  }
}

const LINEN = product('prod-a', 'linen-shirt', 'Linen Shirt', 'Loose and light.')
const WOOL = product('prod-b', 'wool-scarf', 'Wool Scarf', 'Warm and soft.')
const LINEN_PATH = `/products/${LINEN.slug}`
const TYPED = 'Linen Shirt, typed here'

function seed(): ShellApi {
  return fakeShellApi({ products: [structuredClone(LINEN), structuredClone(WOOL)] })
}

const nameField = () => screen.getByTestId('admin-product-name')
const descriptionField = () => screen.getByPlaceholderText('Describe this product...')
const nameShown = () =>
  (screen.queryByTestId('admin-product-name') as HTMLInputElement | null)?.value ?? null
const saveButton = () => screen.getByTestId('admin-product-save')
const dialog = () => screen.queryByTestId('admin-unsaved-dialog')
const marked = () => screen.queryByText('Unsaved changes') !== null
const focused = () => document.activeElement?.getAttribute('data-testid') ?? null

/** The shell on `path` with the real product page, once the product's name has loaded. */
async function openProduct(path = LINEN_PATH, name = LINEN.name): Promise<Shell> {
  const shell = renderAdminShell(path, { productPage: true })
  const field = await screen.findByTestId('admin-product-name', undefined, { timeout: 5000 })
  await waitFor(() => expect(field).toHaveValue(name))
  return shell
}

/** The shell on `from`, then a move to the product, so history holds `from` behind it. */
async function arriveFrom(from: string): Promise<Shell> {
  const shell = renderAdminShell(from, { productPage: true })
  await screen.findByTestId(`admin-products-row-${LINEN.id}`, undefined, { timeout: 5000 })
  await act(() => shell.router.navigate(LINEN_PATH))
  await waitFor(() => expect(nameShown()).toBe(LINEN.name))
  return shell
}

/** Types into the name; the header then marks the form unsaved. */
function typeName(value = TYPED) {
  fireEvent.change(nameField(), { target: { value } })
  screen.getByText('Unsaved changes')
}

/** `g o` with focus on Save, which is not a typing target. */
async function goOrders(user: User) {
  act(() => saveButton().focus())
  await user.keyboard('go')
}

/** Cmd/Ctrl-K, the query typed into the palette's field, the option highlighted, then Enter. */
async function pickFromPalette(user: User, query: string, option: RegExp) {
  await user.keyboard('{Control>}k{/Control}')
  const field = await screen.findByTestId('admin-search-input')
  await waitFor(() => expect(document.activeElement, 'the palette field takes the keyboard').toBe(field))
  await user.keyboard(query)
  const choice = await screen.findByRole('option', { name: option }, { timeout: 3000 })
  for (let i = 0; i < 12 && choice.getAttribute('aria-selected') !== 'true'; i += 1) {
    await user.keyboard('{ArrowDown}')
  }
  expect(choice, 'the option to pick holds the highlight').toHaveAttribute('aria-selected', 'true')
  await user.keyboard('{Enter}')
}

/** Waits until the way out has done something: the dialog shows, or the router has left `from`. */
async function settled(shell: Shell, from: string) {
  await waitFor(() =>
    expect(dialog() !== null || shell.path() !== from, 'the dialog, or a navigation').toBe(true),
  )
}

const outcome = (shell: Shell) => ({
  asked: dialog() !== null,
  path: shell.path(),
  name: nameShown(),
})

const leaveUnsaved = (shell: Shell) => ({ path: shell.path(), name: nameShown(), marked: marked() })

/** A cancelable `beforeunload` on `window`, as a reload or a tab close sends it: whether a listener asked to stay. */
function unloadPrevented(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

beforeAll(polyfillRadix)

afterEach(() => {
  act(() => useCommandPalette.getState().close())
  vi.unstubAllGlobals()
})

const WAYS_TO_ORDERS: Record<string, (user: User) => Promise<void>> = {
  'the sidebar Orders link': (user) => user.click(screen.getByTestId('admin-nav-orders')),
  'g o': goOrders,
  'the palette Orders pick': (user) => pickFromPalette(user, 'orders', /^Go to Orders$/),
}

describe('nothing asks when nothing would be lost', () => {
  // Kills: a guard that asks on a clean form. The edited leg of each way shows the guard is mounted, so the clean
  // leg's silence is its judgement and not its absence.
  it('AC-1: with no edit, the sidebar Orders link, g o and the palette Orders pick each navigate at once with no dialog; the same way after an edit asks', async () => {
    const user = userEvent.setup()
    const clean: Record<string, ReturnType<typeof outcome>> = {}
    const edited: Record<string, ReturnType<typeof outcome>> = {}
    for (const [way, leave] of Object.entries(WAYS_TO_ORDERS)) {
      seed()
      const shell = await openProduct()

      await leave(user)
      await settled(shell, LINEN_PATH)
      clean[way] = outcome(shell)

      await act(() => shell.router.navigate(LINEN_PATH))
      await waitFor(() => expect(nameShown()).toBe(LINEN.name))
      typeName()
      await leave(user)
      await settled(shell, LINEN_PATH)
      edited[way] = outcome(shell)

      act(() => useCommandPalette.getState().close())
      cleanup()
    }
    const ways = Object.keys(WAYS_TO_ORDERS)
    expect(clean, 'clean form').toEqual(
      Object.fromEntries(ways.map((w) => [w, { asked: false, path: '/orders', name: null }])),
    )
    expect(edited, 'after an edit').toEqual(
      Object.fromEntries(ways.map((w) => [w, { asked: true, path: LINEN_PATH, name: TYPED }])),
    )
  })

  // Kills: a guard that asks on a navigation that leaves nothing (the product already open).
  it('AC-1: with an edit, a palette pick of the product already open leaves the path and the typed name as they were, with no dialog; a sidebar Orders click then asks', async () => {
    seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    typeName()

    await pickFromPalette(user, 'linen', new RegExp(LINEN.name))
    await waitFor(() =>
      expect(screen.queryByTestId('admin-search-input'), 'the palette after the pick').toBeNull(),
    )

    expect(outcome(shell), 'after picking the open product').toEqual({
      asked: false,
      path: LINEN_PATH,
      name: TYPED,
    })
    expect(marked(), 'the unsaved mark after picking the open product').toBe(true)

    await user.click(screen.getByTestId('admin-nav-orders'))
    await settled(shell, LINEN_PATH)
    expect(outcome(shell), 'a way to another page, after the same edit').toEqual({
      asked: true,
      path: LINEN_PATH,
      name: TYPED,
    })
  })
})

describe('every way out asks while the edit is unsaved', () => {
  // Kills: any way out leaving without asking, which is every way before the guard.
  it('AC-2: after typing into the name, the sidebar Orders link, g o, the palette Orders pick, the header Products link and history back each ask, with the path and the typed name unchanged', async () => {
    const ways: Record<
      string,
      { from?: string; leave: (user: User, shell: Shell) => Promise<void> }
    > = {
      ...Object.fromEntries(
        Object.entries(WAYS_TO_ORDERS).map(([way, leave]) => [
          way,
          { leave: (user: User) => leave(user) },
        ]),
      ),
      'the header Products link': {
        leave: (user) =>
          user.click(within(screen.getByRole('main')).getByRole('link', { name: 'Products' })),
      },
      'history back': {
        from: '/products',
        leave: (_user, shell) => act(() => shell.router.navigate(-1)),
      },
    }

    const user = userEvent.setup()
    const seen: Record<string, ReturnType<typeof outcome>> = {}
    for (const [way, { from, leave }] of Object.entries(ways)) {
      seed()
      const shell = from ? await arriveFrom(from) : await openProduct()
      typeName()

      await leave(user, shell)
      await settled(shell, LINEN_PATH)
      seen[way] = outcome(shell)

      act(() => useCommandPalette.getState().close())
      cleanup()
    }

    expect(seen).toEqual(
      Object.fromEntries(
        Object.keys(ways).map((w) => [w, { asked: true, path: LINEN_PATH, name: TYPED }]),
      ),
    )
  })
})

describe('Stay keeps the edit; Leave goes where asked', () => {
  // Kills: Stay dropping the edit; the blocker never reset, so every later navigation hangs; focus lost on close, so
  // the next g o is dead or lands in a field; Leave, not Stay, holding focus, so Enter drops the edit.
  it('AC-3: g o asks; Stay, Escape and Enter on the focused Stay each close the dialog with the path, the typed name and the mark unchanged and focus back on Save, and the next g o asks again', async () => {
    seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    typeName()
    const before = leaveUnsaved(shell)

    await goOrders(user)
    await screen.findByTestId('admin-unsaved-dialog')

    const dismissals: Record<string, () => Promise<void>> = {
      'a click on Stay': () => user.click(screen.getByTestId('admin-unsaved-stay')),
      Escape: () => user.keyboard('{Escape}'),
      'Enter on the focused Stay': async () => {
        expect(focused(), 'focus when the dialog opens').toBe('admin-unsaved-stay')
        await user.keyboard('{Enter}')
      },
    }
    for (const [how, dismiss] of Object.entries(dismissals)) {
      await dismiss()
      await waitFor(() => expect(dialog(), `${how}: the dialog`).toBeNull())
      expect(leaveUnsaved(shell), `${how}: the page`).toEqual(before)
      expect(focused(), `${how}: focus after the dialog closes`).toBe('admin-product-save')

      await user.keyboard('go')
      await settled(shell, LINEN_PATH)
      expect(outcome(shell), `${how}: the next g o`).toEqual({
        asked: true,
        path: before.path,
        name: before.name,
      })
    }
  })

  // Kills: Leave going somewhere other than where the merchant asked, or nowhere.
  it('AC-3: Leave goes to the path that was asked for: /orders for g o, /products for the header Products link', async () => {
    const user = userEvent.setup()
    const ways: Array<[string, (user: User) => Promise<void>, string]> = [
      ['g o', goOrders, '/orders'],
      [
        'the header Products link',
        (u) => u.click(within(screen.getByRole('main')).getByRole('link', { name: 'Products' })),
        '/products',
      ],
    ]
    const reached: Record<string, string> = {}
    for (const [way, leave] of ways) {
      seed()
      const shell = await openProduct()
      typeName()
      await leave(user)
      await user.click(await screen.findByTestId('admin-unsaved-leave'))
      await waitFor(() => expect(shell.path(), way).not.toBe(LINEN_PATH))
      reached[way] = shell.path()
      cleanup()
    }
    expect(reached).toEqual(Object.fromEntries(ways.map(([way, , to]) => [way, to])))
  })
})

describe('an edit belongs to one product', () => {
  // Kills: an in-place move to another product dropping A's edit without asking; A's typed values carried to B.
  it("AC-4: with an edit on product A, a palette pick of product B asks; Stay keeps A's path, typed name and description; picked again and Leave, the page shows B, and Save sends one PATCH, to B, with B's values and B's variant ids, while A is unchanged at the fake API", async () => {
    const api = seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    typeName('Linen Shirt, typed on A')
    fireEvent.change(descriptionField(), { target: { value: 'Typed on A.' } })

    await pickFromPalette(user, 'wool', new RegExp(WOOL.name))
    await screen.findByTestId('admin-unsaved-dialog')
    await user.click(screen.getByTestId('admin-unsaved-stay'))
    await waitFor(() => expect(dialog(), 'the dialog after Stay').toBeNull())
    expect(
      {
        path: shell.path(),
        name: nameShown(),
        description: (descriptionField() as HTMLTextAreaElement).value,
      },
      "A's page after Stay",
    ).toEqual({ path: LINEN_PATH, name: 'Linen Shirt, typed on A', description: 'Typed on A.' })

    await pickFromPalette(user, 'wool', new RegExp(WOOL.name))
    await user.click(await screen.findByTestId('admin-unsaved-leave'))
    await waitFor(() => expect(nameField(), "B's name").toHaveValue(WOOL.name))
    expect(shell.path()).toBe(`/products/${WOOL.slug}`)
    expect(descriptionField(), "B's description").toHaveValue(WOOL.description)

    await user.click(saveButton())
    const patches = () => api.requests.filter((r) => r.method === 'PATCH')
    await waitFor(() => expect(patches().length, 'PATCHes sent').toBe(1))
    const patch = patches()[0]! as {
      path: string
      body: Record<string, unknown> & { variants?: Array<{ id: string }> }
    }
    expect(patch.path, 'the product PATCHed').toBe(`/api/admin/products/${WOOL.id}`)
    expect([patch.body['name'], patch.body['description']], 'the values sent').toEqual([
      WOOL.name,
      WOOL.description,
    ])
    expect(
      patch.body.variants?.map((v) => v.id),
      'the variant ids sent',
    ).toEqual(WOOL.variants.map((v) => v.id))
    expect(
      (api.products as ProductSnapshot[]).find((p) => p.id === LINEN.id),
      'product A at the fake API',
    ).toEqual(LINEN)
  })
})

describe('a finished save lets its own navigation through', () => {
  // Kills: a guard that still asks once the save has cleared the mark.
  it('AC-5: on an existing product, g o asks while the edit is unsaved; after Save clears the mark, g o navigates to /orders with no dialog', async () => {
    const api = seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    typeName()
    await goOrders(user)
    await screen.findByTestId('admin-unsaved-dialog')
    await user.click(screen.getByTestId('admin-unsaved-stay'))
    await waitFor(() => expect(dialog()).toBeNull())

    await user.click(saveButton())
    await waitFor(() => expect(marked(), 'the unsaved mark after Save').toBe(false))
    expect(api.requests.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual([
      `/api/admin/products/${LINEN.id}`,
    ])

    await goOrders(user)
    await settled(shell, LINEN_PATH)
    expect(outcome(shell), 'g o after the save').toEqual({
      asked: false,
      path: '/orders',
      name: null,
    })
  })

  // Kills: the create's own navigation held by a blocker that still reads the dirty value from before the save.
  it('AC-5: on /products/new, g o asks while the name is unsaved; Create then moves to /products/<the slug the API answered> with no dialog', async () => {
    const api = seed()
    const user = userEvent.setup()
    const shell = renderAdminShell('/products/new', { productPage: true })
    await screen.findByTestId('admin-product-name', undefined, { timeout: 5000 })
    typeName('Cotton Tote')
    await goOrders(user)
    await screen.findByTestId('admin-unsaved-dialog')
    await user.click(screen.getByTestId('admin-unsaved-stay'))
    await waitFor(() => expect(dialog()).toBeNull())

    await user.click(saveButton())
    await waitFor(() =>
      expect(
        api.requests.filter((r) => r.method === 'POST' && r.path === '/api/admin/products').length,
      ).toBe(1),
    )
    const created = (api.products as ProductSnapshot[]).find((p) => p.name === 'Cotton Tote')!
    await settled(shell, '/products/new')
    expect({ asked: dialog() !== null, path: shell.path() }, 'after Create').toEqual({
      asked: false,
      path: `/products/${created.slug}`,
    })
  })
})

describe('an ended session is never held', () => {
  // Kills: logout held behind the dialog, leaving the merchant on a page whose Save the server refuses.
  it('AC-6: with an edit, a sidebar Orders click asks; Stay, then Sign out reaches /login with no dialog', async () => {
    seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    typeName()
    await user.click(screen.getByTestId('admin-nav-orders'))
    await screen.findByTestId('admin-unsaved-dialog')
    await user.click(screen.getByTestId('admin-unsaved-stay'))
    await waitFor(() => expect(dialog()).toBeNull())

    await user.click(screen.getByTitle('Sign out'))
    await settled(shell, LINEN_PATH)
    expect({ asked: dialog() !== null, path: shell.path() }, 'after Sign out').toEqual({
      asked: false,
      path: '/login',
    })
  })

  // Kills: a lost session's navigation to /login held behind the dialog.
  it('AC-6: with an edit, g o asks; Stay, then router.navigate("/login") (a lost session) reaches /login with no dialog', async () => {
    seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    typeName()
    await goOrders(user)
    await screen.findByTestId('admin-unsaved-dialog')
    await user.click(screen.getByTestId('admin-unsaved-stay'))
    await waitFor(() => expect(dialog()).toBeNull())

    await act(() => shell.router.navigate('/login'))
    await settled(shell, LINEN_PATH)
    expect({ asked: dialog() !== null, path: shell.path() }, 'after the lost session').toEqual({
      asked: false,
      path: '/login',
    })
  })
})

describe('a reload or a tab close asks while the edit is unsaved', () => {
  // Kills: no reload or close prompt; a prompt on a clean page; a listener left behind after the page is gone.
  it('AC-7: a cancelable beforeunload is not prevented before any edit, is prevented after typing, is not once Save has finished, and is not after Leave has taken the merchant off the page', async () => {
    seed()
    const user = userEvent.setup()
    const shell = await openProduct()
    expect(unloadPrevented(), 'before any edit').toBe(false)

    typeName()
    expect(unloadPrevented(), 'after typing').toBe(true)

    await user.click(saveButton())
    await waitFor(() => expect(marked(), 'the unsaved mark after Save').toBe(false))
    expect(unloadPrevented(), 'once Save has finished').toBe(false)

    typeName('Linen Shirt, typed again')
    expect(unloadPrevented(), 'after typing again').toBe(true)
    await goOrders(user)
    await user.click(await screen.findByTestId('admin-unsaved-leave'))
    await waitFor(() => expect(shell.path()).toBe('/orders'))
    expect(unloadPrevented(), 'after Leave').toBe(false)
  })
})
