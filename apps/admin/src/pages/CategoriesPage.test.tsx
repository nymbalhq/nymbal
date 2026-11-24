import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import type { Category } from '@nymbalhq/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { CategoriesPage } from './CategoriesPage'

// The categories page against a fake admin API (fetch stubbed) that keeps the tree as the server does:
// `GET /api/admin/categories` answers every category in display order (position, then name, then id), a POST creates
// one at the end of its parent's children and refuses an empty or taken slug, a PATCH refuses a slug and a cycle, a
// reorder refuses ids that are not exactly the parent's children, and a DELETE moves the category's children to its
// parent and says how many products left it. A write takes the next of the test's answers (applied when none is left)
// and waits while the test holds it; a key sent again with another request is answered 409 idempotency.key_reused.

const AT = '2026-11-24T10:00:00.000Z'
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DELETE_TEXT = [
  'Its products stay in the store and leave this category.',
  'Its subcategories move up one level.',
]

type Answer =
  | { kind: 'applied' }
  | { kind: 'refused'; status: number; code: string; message: string }

interface Sent {
  method: string
  path: string
  body: unknown
  key: string | null
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function category(over: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    parentId: null,
    slug: over.id.replace(/^cat-/, ''),
    description: '',
    position: 0,
    createdAt: AT,
    ...over,
  }
}

/** The admin route's order: position, then name, then id. */
function byDisplayOrder(a: Category, b: Category): number {
  if (a.position !== b.position) return a.position - b.position
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const isWrite = (s: Sent) => s.method !== 'GET' && s.path.startsWith('/api/admin/categories')

function fakeApi(
  seed: Category[],
  opts: {
    answers?: Answer[]
    hold?: (s: Sent) => boolean
    /** Products in each category, which its delete detaches. */
    products?: Record<string, number>
  } = {},
) {
  let list = seed.map((c) => ({ ...c }))
  const sent: Sent[] = []
  const held: Array<() => void> = []
  let holding = true
  let writes = 0
  let created = 0
  const requestOfKey = new Map<string, string>()
  const refuse = (status: number, code: string, message: string) =>
    json({ error: { code, message } }, status)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const s: Sent = {
      method,
      path: url.pathname,
      body,
      key: new Headers(init.headers).get('idempotency-key'),
    }
    sent.push(s)
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (url.pathname === '/api/admin/me') {
      return json({
        data: {
          userId: 'u-admin',
          roles: ['admin'],
          storeName: 'Test Store',
          environment: 'development',
          currency: 'GBP',
        },
      })
    }
    if (method === 'GET' && url.pathname === '/api/admin/categories') {
      return json({ data: [...list].sort(byDisplayOrder) })
    }
    if (!isWrite(s)) return json({ data: {} })

    const request = JSON.stringify([method, url.pathname, body])
    if (s.key !== null && (requestOfKey.get(s.key) ?? request) !== request) {
      return refuse(
        409,
        'idempotency.key_reused',
        'This Idempotency-Key was already used with a different request',
      )
    }
    if (s.key !== null) requestOfKey.set(s.key, request)
    const answer = opts.answers?.[writes] ?? { kind: 'applied' }
    writes += 1
    if (holding && opts.hold?.(s)) await new Promise<void>((resolve) => held.push(resolve))
    if (answer.kind === 'refused') return refuse(answer.status, answer.code, answer.message)

    const childrenOf = (parentId: string | null) =>
      list.filter((c) => c.parentId === parentId).sort(byDisplayOrder)
    const one = /^\/api\/admin\/categories\/([^/]+)$/.exec(url.pathname)
    if (method === 'POST' && url.pathname === '/api/admin/categories/reorder') {
      const { parentId, ids } = body as { parentId: string | null; ids: string[] }
      const children = childrenOf(parentId)
      if (
        ids.length !== children.length ||
        new Set(ids).size !== ids.length ||
        !ids.every((id) => children.some((c) => c.id === id))
      ) {
        return refuse(
          400,
          'category.reorder_mismatch',
          'ids must name each child of the parent exactly once',
        )
      }
      list = list.map((c) => (ids.includes(c.id) ? { ...c, position: ids.indexOf(c.id) } : c))
      return json({ data: childrenOf(parentId) })
    }
    if (method === 'POST' && url.pathname === '/api/admin/categories') {
      const fields = body as {
        slug: string
        name: string
        description?: string
        parentId?: string | null
      }
      if (fields.slug === '') {
        return refuse(400, 'validation.failed', 'Category slug is required')
      }
      if (list.some((c) => c.slug === fields.slug)) {
        return refuse(400, 'validation.failed', `Category slug already exists: ${fields.slug}`)
      }
      created += 1
      const parentId = fields.parentId ?? null
      const made = category({
        id: `cat-new-${created}`,
        name: fields.name,
        slug: fields.slug,
        description: fields.description ?? '',
        parentId,
        position: childrenOf(parentId).length,
      })
      list = [...list, made]
      return json({ data: made }, 201)
    }
    if (method === 'PATCH' && one) {
      const id = decodeURIComponent(one[1]!)
      const stored = list.find((c) => c.id === id)
      if (stored === undefined) return refuse(404, 'category.not_found', `No category ${id}`)
      const fields = body as Partial<Category>
      if ('slug' in fields) return refuse(400, 'validation.failed', 'Unrecognized key: "slug"')
      const under = (parent: string | null | undefined): boolean => {
        for (let at = parent; at != null; at = list.find((c) => c.id === at)?.parentId) {
          if (at === id) return true
        }
        return false
      }
      if (under(fields.parentId)) {
        return refuse(
          400,
          'category.parent_cycle',
          `A category cannot sit under itself or a descendant: ${id}`,
        )
      }
      const updated = { ...stored, ...fields }
      list = list.map((c) => (c.id === id ? updated : c))
      return json({ data: updated })
    }
    if (method === 'DELETE' && one) {
      const id = decodeURIComponent(one[1]!)
      const stored = list.find((c) => c.id === id)
      if (stored === undefined) return refuse(404, 'category.not_found', `No category ${id}`)
      const moved = list.filter((c) => c.parentId === id)
      list = list
        .filter((c) => c.id !== id)
        .map((c) => (c.parentId === id ? { ...c, parentId: stored.parentId } : c))
      return json({
        data: {
          ok: true,
          detachedProducts: opts.products?.[id] ?? 0,
          movedChildren: moved.length,
        },
      })
    }
    return json({ data: {} })
  })
  return {
    sent,
    writes: () => sent.filter(isWrite),
    of: (method: string, path?: string) =>
      sent.filter(
        (s) => isWrite(s) && s.method === method && (path === undefined || s.path === path),
      ),
    reorders: () =>
      sent.filter((s) => s.method === 'POST' && s.path === '/api/admin/categories/reorder'),
    listGets: () => sent.filter((s) => s.method === 'GET' && s.path === '/api/admin/categories'),
    release: () => {
      holding = false
      held.splice(0).forEach((open) => open())
    },
  }
}

const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const text = (el: Element | null) => el?.textContent?.trim() ?? ''
const ROW = 'admin-categories-row-'

function renderPage() {
  return renderWithProviders(<CategoriesPage />, { initialPath: '/categories', dataRouter: true })
}

const rowOf = (id: string) => screen.findByTestId(`${ROW}${id}`, undefined, { timeout: 5000 })
/** The ids of the rows, top to bottom. */
const rowIds = () =>
  screen
    .queryAllByTestId(new RegExp(`^${ROW}`))
    .map((el) => el.dataset['testid']!.slice(ROW.length))
const depthOf = (id: string) => screen.getByTestId(`${ROW}${id}`).getAttribute('data-depth')
const upOf = (id: string) => screen.getByTestId(`admin-categories-up-${id}`)
const downOf = (id: string) => screen.getByTestId(`admin-categories-down-${id}`)
const editOf = (id: string) => screen.getByTestId(`admin-categories-edit-${id}`)
const deleteOf = (id: string) => screen.getByTestId(`admin-categories-delete-${id}`)
const field = (name: string) => screen.getByTestId(`admin-category-${name}`)
const input = (name: string) => field(name) as HTMLInputElement
const isDisabled = (el: Element) =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
const resultText = () => text(screen.queryByTestId('admin-categories-result'))

/** The product form's slug rule (`ProductEditPage.tsx`), before the 80-character cap. */
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** An option's text names `name` when, past any indent marks, it is the name alone. */
const names = (option: string, name: string) =>
  new RegExp(`^[^\\p{L}\\p{N}]*${escape(name)}$`, 'u').test(option)

/** The parent control's options as the merchant reads them: a native select's, or a listbox's once opened. */
async function parentOptions(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  const control = field('parent')
  if (control instanceof HTMLSelectElement) return [...control.options].map(text)
  await user.click(control)
  const listbox = await screen.findByRole('listbox')
  const options = within(listbox).getAllByRole('option').map(text)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  return options
}

/** The parent the control shows as chosen. */
function chosenParent(): string {
  const control = field('parent')
  if (control instanceof HTMLSelectElement) return text(control.selectedOptions[0] ?? null)
  return text(control)
}

async function chooseParent(user: ReturnType<typeof userEvent.setup>, name: string) {
  const control = field('parent')
  if (control instanceof HTMLSelectElement) {
    const option = [...control.options].find((o) => names(text(o), name))
    expect(option, `the parent select offers ${name}`).toBeInstanceOf(HTMLOptionElement)
    await user.selectOptions(control, option!)
    return
  }
  await user.click(control)
  const listbox = await screen.findByRole('listbox')
  const option = within(listbox)
    .getAllByRole('option')
    .find((o) => names(text(o), name))
  expect(option, `the parent listbox offers ${name}`).toBeInstanceOf(HTMLElement)
  await user.click(option!)
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, name: string, value: string) {
  const el = input(name)
  await user.clear(el)
  if (value !== '') await user.type(el, value)
}

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByTestId('admin-categories-new', undefined, { timeout: 5000 })
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
  return screen.findByTestId('admin-category-dialog')
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

// Two roots whose children the API orders against their names, and the second root's name before the first's: a page
// that lists the API's flat order, or sorts siblings by name, reads differently.
const GARDEN = category({ id: 'cat-garden', name: 'Garden', position: 0 })
const SEEDS = category({ id: 'cat-seeds', name: 'Seeds', parentId: GARDEN.id, position: 0 })
const BULBS = category({ id: 'cat-bulbs', name: 'Bulbs', parentId: GARDEN.id, position: 1 })
const APPAREL = category({ id: 'cat-apparel', name: 'Apparel', position: 1 })

describe('the tree shows the store’s order', () => {
  // Kills: children listed apart from their parent, or siblings re-sorted by name against the store's order.
  it('AC-1: a root with two children and a second root read root, its children as the API ordered them, second root, at depths 0, 1, 1, 0, each row with its name and slug; Move up is disabled on each first sibling and Move down on each last', async () => {
    fakeApi([BULBS, APPAREL, SEEDS, GARDEN])
    renderPage()
    await rowOf(APPAREL.id)

    const order = [GARDEN, SEEDS, BULBS, APPAREL]
    expect(rowIds()).toEqual(order.map((c) => c.id))
    expect(order.map((c) => depthOf(c.id))).toEqual(['0', '1', '1', '0'])
    for (const c of order) {
      const row = screen.getByTestId(`${ROW}${c.id}`)
      expect(row.textContent ?? '', `${c.id}: name and slug`).toContain(c.name)
      expect(row.textContent ?? '', `${c.id}: slug`).toContain(c.slug)
      expect(upOf(c.id)).toHaveAccessibleName(`Move ${c.name} up`)
      expect(downOf(c.id)).toHaveAccessibleName(`Move ${c.name} down`)
    }
    expect(
      Object.fromEntries(
        order.map((c) => [c.id, [isDisabled(upOf(c.id)), isDisabled(downOf(c.id))]]),
      ),
      '[Move up disabled, Move down disabled]',
    ).toEqual({
      [GARDEN.id]: [true, false],
      [SEEDS.id]: [true, false],
      [BULBS.id]: [false, true],
      [APPAREL.id]: [false, true],
    })
    expect(screen.queryByText('No categories yet.')).toBeNull()
  })

  // Kills: a category whose parent the list does not hold dropped from the page, or nested under nothing.
  it('AC-1: a category whose parentId names no row is listed at depth 0', async () => {
    const ORPHAN = category({ id: 'cat-orphan', name: 'Orphan', parentId: 'cat-gone', position: 0 })
    fakeApi([GARDEN, ORPHAN])
    renderPage()

    await rowOf(ORPHAN.id)
    expect(depthOf(ORPHAN.id)).toBe('0')
    expect([...rowIds()].sort()).toEqual([GARDEN.id, ORPHAN.id].sort())
  })

  // Kills: an empty store that renders a blank list.
  it('AC-1: an empty answer shows "No categories yet." and no row', async () => {
    const api = fakeApi([])
    renderPage()

    await waitFor(() => expect(api.listGets().length, 'list reads').toBeGreaterThan(0))
    const empty = await screen.findByText('No categories yet.', undefined, { timeout: 5000 })
    expect(text(empty)).toBe('No categories yet.')
    expect(rowIds()).toEqual([])
  })

  // Kills: a tree built for two levels only, a child placed after a later root, or the first/last rule read from the
  // whole list instead of the row's siblings.
  it('AC-1: property: for any tree in any position order, the rows are its pre-order walk with siblings in the API’s order, data-depth is each row’s depth, and Move up / Move down are disabled exactly on the first / last of their siblings', async () => {
    const tree = fc
      .array(
        fc.record({
          parent: fc.nat(),
          root: fc.boolean(),
          position: fc.integer({ min: 0, max: 3 }),
          word: fc.constantFrom('Alpha', 'Birch', 'Cedar', 'Delta', 'Elm', 'Fern', 'Gorse'),
        }),
        { minLength: 1, maxLength: 9 },
      )
      .map((nodes) =>
        nodes.map((n, i) =>
          category({
            id: `cat-${i}`,
            name: `${n.word} ${i}`,
            slug: `${n.word.toLowerCase()}-${i}`,
            // Each node's parent comes before it, so the tree has no cycle.
            parentId: i === 0 || n.root ? null : `cat-${n.parent % i}`,
            position: n.position,
          }),
        ),
      )
    await fc.assert(
      fc.asyncProperty(tree, async (categories) => {
        fakeApi(categories)
        const { unmount } = renderPage()
        try {
          await waitFor(() => expect(rowIds()).toHaveLength(categories.length), { timeout: 5000 })
          const ordered = [...categories].sort(byDisplayOrder)
          const walk: Array<{ id: string; depth: string; first: boolean; last: boolean }> = []
          const visit = (parentId: string | null, depth: number) => {
            const siblings = ordered.filter((c) => c.parentId === parentId)
            siblings.forEach((c, i) => {
              walk.push({
                id: c.id,
                depth: String(depth),
                first: i === 0,
                last: i === siblings.length - 1,
              })
              visit(c.id, depth + 1)
            })
          }
          visit(null, 0)

          expect(
            rowIds().map((id) => ({
              id,
              depth: depthOf(id),
              first: isDisabled(upOf(id)),
              last: isDisabled(downOf(id)),
            })),
          ).toEqual(walk)
        } finally {
          unmount()
          vi.unstubAllGlobals()
        }
      }),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 12, endOnFailure: true },
    )
  }, 30_000)
})

describe('a new category is sent as typed', () => {
  // Kills: a slug that stops following the name before the merchant edits it, or keeps following it after.
  it('AC-2: typing a name fills the slug by the product form’s rule; once the slug is edited, more typing in the name leaves it', async () => {
    fakeApi([GARDEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(GARDEN.id)
    await openNew(user)

    await typeInto(user, 'name', 'Garden Tools & Sheds')
    expect(input('slug').value).toBe(slugify('Garden Tools & Sheds'))
    await typeInto(user, 'slug', 'tools')
    await user.type(input('name'), ' Extra')

    expect([input('name').value, input('slug').value]).toEqual([
      'Garden Tools & Sheds Extra',
      'tools',
    ])
  })

  // Kills: a slug made by another rule than the product form's (spaces kept, case kept), or longer than the server's
  // 80 characters, so the server refuses a name the merchant typed in good faith.
  it('AC-2: property: for any name, the slug the dialog fills is the product form’s slug of it, cut to at most 80 characters', async () => {
    fakeApi([GARDEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(GARDEN.id)
    await openNew(user)

    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 140 }),
          fc.string({ unit: 'grapheme', maxLength: 40 }),
          fc.stringMatching(/^[A-Za-z0-9 ]{70,120}$/),
        ),
        (name) => {
          fireEvent.change(input('name'), { target: { value: name } })
          const slug = input('slug').value
          const full = slugify(name)
          // Within the cap the slug is the rule's whole; past it, the rule's first 80 characters, less a trailing
          // hyphen the cut may leave.
          expect(
            {
              withinCap: slug.length <= 80,
              startOfRule: full.startsWith(slug),
              cutOnlyAtCap: full.length <= 80 ? slug === full : slug.length >= 79,
            },
            `${JSON.stringify(name)} → ${JSON.stringify(slug)}, the rule gives ${JSON.stringify(full)}`,
          ).toEqual({ withinCap: true, startOfRule: true, cutOnlyAtCap: true })
        },
      ),
      { numRuns: 80 },
    )
  })

  // Kills: a body missing a field, a parent sent as "" or left out instead of null, or a dialog that stays open over
  // a category that was made.
  it('AC-2: Save sends one POST { slug, name, description, parentId: null } for "None"; on 201 the dialog closes, the list is read again with the new row, and the result reads "Created <name>"', async () => {
    const api = fakeApi([GARDEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(GARDEN.id)
    const readsBefore = api.listGets().length
    await openNew(user)

    await typeInto(user, 'name', 'Outdoor Lights')
    await typeInto(user, 'description', 'Lamps for the garden path.')
    await user.click(field('save'))

    await waitFor(() => expect(resultText()).toBe('Created Outdoor Lights'))
    expect(screen.getByTestId('admin-categories-result')).toHaveAttribute('role', 'status')
    expect(api.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      [
        'POST',
        '/api/admin/categories',
        {
          slug: 'outdoor-lights',
          name: 'Outdoor Lights',
          description: 'Lamps for the garden path.',
          parentId: null,
        },
      ],
    ])
    expect(screen.queryByTestId('admin-category-dialog'), 'the dialog once created').toBeNull()
    expect(api.listGets().length, 'list reads after the create').toBeGreaterThan(readsBefore)
    const made = await rowOf('cat-new-1')
    expect(made.textContent ?? '').toContain('Outdoor Lights')
  })

  // Kills: the chosen parent dropped from the body, so the category is made at the top level.
  it('AC-2: a parent chosen in the select is sent as its id, and the new row is listed under it at depth 1', async () => {
    const api = fakeApi([GARDEN, APPAREL])
    const user = userEvent.setup()
    renderPage()
    await rowOf(APPAREL.id)
    await openNew(user)

    await typeInto(user, 'name', 'Hats')
    await chooseParent(user, APPAREL.name)
    await user.click(field('save'))

    await waitFor(() => expect(resultText()).toBe('Created Hats'))
    expect(api.of('POST').map((w) => w.body)).toEqual([
      { slug: 'hats', name: 'Hats', description: '', parentId: APPAREL.id },
    ])
    await rowOf('cat-new-1')
    expect(rowIds().slice(rowIds().indexOf(APPAREL.id))).toEqual([APPAREL.id, 'cat-new-1'])
    expect(depthOf('cat-new-1')).toBe('1')
  })

  // Kills: the server's "slug already exists" dropped and the dialog closed on a category that was not made.
  it('AC-2: a 400 "Category slug already exists" keeps the dialog open with what was typed, shows the server’s message in its alert, and nothing reads "Created"', async () => {
    const api = fakeApi([GARDEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(GARDEN.id)
    await openNew(user)

    await typeInto(user, 'name', 'Garden')
    await typeInto(user, 'description', 'A second garden.')
    await user.click(field('save'))

    const alert = await screen.findByTestId('admin-category-error', undefined, { timeout: 5000 })
    await waitFor(() => expect(text(alert)).toBe(`Category slug already exists: ${GARDEN.slug}`))
    expect(alert).toHaveAttribute('role', 'alert')
    await waitFor(() => expect(field('save')).toBeEnabled())
    expect(screen.queryByTestId('admin-category-dialog'), 'the dialog').not.toBeNull()
    expect([input('name').value, input('slug').value, input('description').value]).toEqual([
      'Garden',
      GARDEN.slug,
      'A second garden.',
    ])
    expect(api.of('POST')).toHaveLength(1)
    expect(resultText(), 'the outcome line').not.toMatch(/^Created/)
  })

  // Kills: a name with no ASCII letter or digit that the page swallows: nothing sent and nothing said, or a made-up
  // slug the merchant never saw.
  it('AC-2: a name with no ASCII letter or digit fills the slug with "" and Save shows the server’s 400 in the dialog', async () => {
    const api = fakeApi([GARDEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(GARDEN.id)
    await openNew(user)

    await typeInto(user, 'name', '日本の庭')
    expect(input('slug').value).toBe('')
    await user.click(field('save'))

    const alert = await screen.findByTestId('admin-category-error', undefined, { timeout: 5000 })
    await waitFor(() => expect(text(alert)).toBe('Category slug is required'))
    expect(api.of('POST').map((w) => (w.body as { slug: string }).slug)).toEqual([''])
    expect(input('name').value).toBe('日本の庭')
  })
})

describe('one Save is one create', () => {
  // Kills: two clicks making two requests, the second answered "slug already exists" over a create that worked.
  it('AC-3: Save clicked, the POST held open, Save clicked again and Enter pressed in the name field send one POST in all, with Save disabled meanwhile; once answered the result reads "Created <name>" and no error shows', async () => {
    const api = fakeApi([GARDEN], { hold: (s) => s.method === 'POST' })
    const user = userEvent.setup()
    renderPage()
    await rowOf(GARDEN.id)
    await openNew(user)
    await typeInto(user, 'name', 'Planters')

    await user.click(field('save'))
    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    await waitFor(() => expect(field('save')).toBeDisabled())
    fireEvent.click(field('save'))
    input('name').focus()
    await user.keyboard('{Enter}')
    await aTurn()

    expect(api.of('POST'), 'POSTs while the first is open').toHaveLength(1)
    await act(async () => {
      api.release()
    })
    await waitFor(() => expect(resultText()).toBe('Created Planters'))
    expect(api.of('POST'), 'POSTs in all').toHaveLength(1)
    expect(text(screen.queryByTestId('admin-category-error')), 'the dialog’s alert').toBe('')
    expect(text(screen.queryByTestId('admin-categories-error')), 'the page’s alert').toBe('')
  })

  // Kills: a fresh key per click, so k clicks landing before the re-render are k commands the server cannot fold.
  it('AC-3: property: k clicks of Save before a re-render all carry one well-formed Idempotency-Key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
        const api = fakeApi([GARDEN], { hold: (s) => s.method === 'POST' })
        const user = userEvent.setup()
        const { unmount } = renderPage()
        try {
          await rowOf(GARDEN.id)
          await openNew(user)
          await typeInto(user, 'name', 'Planters')
          const save = field('save')

          act(() => {
            for (let i = 0; i < k; i += 1) save.click()
          })
          await waitFor(() => expect(api.writes().length).toBeGreaterThan(0))
          await aTurn()

          const keys = api.writes().map((w) => w.key)
          expect(keys.length, `×${k}: writes`).toBeLessThanOrEqual(k)
          expect(new Set(keys).size, `×${k}: keys ${JSON.stringify(keys)}`).toBe(1)
          expect(KEY_PATTERN.test(keys[0] ?? ''), `key ${keys[0]}`).toBe(true)
        } finally {
          await act(async () => {
            api.release()
          })
          unmount()
          vi.unstubAllGlobals()
        }
      }),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 5, endOnFailure: true },
    )
  }, 30_000)
})

// A → B → C and D → E: B's parent can be None, A, D or E, never B itself or its child C.
const A = category({ id: 'cat-a', name: 'Kitchen', position: 0, description: 'Pots and pans.' })
const B = category({ id: 'cat-b', name: 'Cookware', parentId: A.id, description: 'For the hob.' })
const C = category({ id: 'cat-c', name: 'Skillets', parentId: B.id })
const D = category({ id: 'cat-d', name: 'Dining', position: 1 })
const E = category({ id: 'cat-e', name: 'Tableware', parentId: D.id })
const TREE = [A, B, C, D, E]

describe('an edit changes name, description and parent', () => {
  // Kills: a category offered as a parent of itself or of its own ancestor, so the form can make a cycle.
  it.each([
    { edited: B, offered: [A, D, E] },
    { edited: A, offered: [D, E] },
  ])(
    'AC-4: Edit of $edited.name offers "None" and every category but it and its descendants as the parent',
    async ({ edited, offered }) => {
      fakeApi(TREE)
      const user = userEvent.setup()
      renderPage()
      await rowOf(edited.id)

      await user.click(editOf(edited.id))
      await screen.findByTestId('admin-category-dialog')
      const options = await parentOptions(user)

      expect(
        options.filter((o) => o === 'None'),
        'the None option',
      ).toEqual(['None'])
      expect(
        Object.fromEntries(TREE.map((c) => [c.name, options.some((o) => names(o, c.name))])),
        `options ${JSON.stringify(options)}`,
      ).toEqual(Object.fromEntries(TREE.map((c) => [c.name, offered.includes(c)])))
    },
  )

  // Kills: a form that opens blank or on another row, a slug offered for change, or a PATCH carrying a slug the route
  // refuses.
  it('AC-4: Edit opens with the row’s name, description and parent and its slug as text; Save sends one PATCH { name, description, parentId } with no slug, and the result reads "Saved <name>"', async () => {
    const api = fakeApi(TREE)
    const user = userEvent.setup()
    renderPage()
    await rowOf(B.id)

    await user.click(editOf(B.id))
    await screen.findByTestId('admin-category-dialog')
    const slug = field('slug')
    const editable =
      (slug instanceof HTMLInputElement || slug instanceof HTMLTextAreaElement) &&
      !slug.readOnly &&
      !slug.disabled
    expect({
      name: input('name').value,
      description: input('description').value,
      slug: slug instanceof HTMLInputElement ? slug.value : text(slug),
      slugEditable: editable,
    }).toEqual({ name: B.name, description: B.description, slug: B.slug, slugEditable: false })
    expect(names(chosenParent(), A.name), `the parent shown: ${chosenParent()}`).toBe(true)

    await typeInto(user, 'name', 'Pans')
    await typeInto(user, 'description', 'Frying and sauté.')
    await chooseParent(user, D.name)
    await user.click(field('save'))

    await waitFor(() => expect(resultText()).toBe('Saved Pans'))
    expect(api.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      [
        'PATCH',
        `/api/admin/categories/${B.id}`,
        { name: 'Pans', description: 'Frying and sauté.', parentId: D.id },
      ],
    ])
    await waitFor(() => expect(text(screen.getByTestId(`${ROW}${B.id}`))).toContain('Pans'))
    expect(rowIds().indexOf(B.id), 'the row under its new parent').toBeGreaterThan(
      rowIds().indexOf(D.id),
    )
    expect(screen.queryByTestId('admin-category-dialog'), 'the dialog once saved').toBeNull()
  })

  // Kills: the server's cycle refusal dropped, so the dialog closes on a move that never happened.
  it('AC-4: a 400 category.parent_cycle shows its message in the dialog’s alert; the dialog stays open and the row keeps its parent', async () => {
    const message = `A category cannot sit under itself or a descendant: ${B.id}`
    const api = fakeApi(TREE, {
      answers: [{ kind: 'refused', status: 400, code: 'category.parent_cycle', message }],
    })
    const user = userEvent.setup()
    renderPage()
    await rowOf(B.id)

    await user.click(editOf(B.id))
    await screen.findByTestId('admin-category-dialog')
    await chooseParent(user, E.name)
    await user.click(field('save'))

    const alert = await screen.findByTestId('admin-category-error', undefined, { timeout: 5000 })
    await waitFor(() => expect(text(alert)).toBe(message))
    expect(alert).toHaveAttribute('role', 'alert')
    expect(api.of('PATCH')).toHaveLength(1)
    expect(screen.queryByTestId('admin-category-dialog'), 'the dialog').not.toBeNull()
    expect(depthOf(B.id), 'B still under Kitchen').toBe('1')
    expect(resultText(), 'the outcome line').not.toMatch(/^Saved/)
  })
})

// Two parents of three and two children.
const P = category({ id: 'cat-p', name: 'Plants', position: 0 })
const PA = category({ id: 'cat-pa', name: 'Ferns', parentId: P.id, position: 0 })
const PB = category({ id: 'cat-pb', name: 'Mosses', parentId: P.id, position: 1 })
const PC = category({ id: 'cat-pc', name: 'Palms', parentId: P.id, position: 2 })
const Q = category({ id: 'cat-q', name: 'Quilts', position: 1 })
const QX = category({ id: 'cat-qx', name: 'Wool', parentId: Q.id, position: 0 })
const QY = category({ id: 'cat-qy', name: 'Cotton', parentId: Q.id, position: 1 })
const SIBLINGS = [P, PA, PB, PC, Q, QX, QY]

const childrenShown = (parent: Category) =>
  rowIds().filter((id) => SIBLINGS.find((c) => c.id === id)?.parentId === parent.id)

describe('a move reorders one parent’s children in the store', () => {
  // Kills: a move that swaps rows on the page and sends nothing, or sends an order other than the swap.
  it('AC-5: with siblings a, b, c, Move down on a sends one POST /api/admin/categories/reorder { parentId, ids: [b, a, c] }; on 200 the rows read b, a, c and the result "Moved <a>"', async () => {
    const api = fakeApi(SIBLINGS)
    const user = userEvent.setup()
    renderPage()
    await rowOf(PC.id)

    await user.click(downOf(PA.id))

    await waitFor(() => expect(resultText()).toBe(`Moved ${PA.name}`))
    expect(api.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['POST', '/api/admin/categories/reorder', { parentId: P.id, ids: [PB.id, PA.id, PC.id] }],
    ])
    expect(childrenShown(P)).toEqual([PB.id, PA.id, PC.id])
  })

  // Kills: two quick moves sending two orders computed from one stale list, so the second undoes the first; or one
  // key for every parent, which the server answers 409 idempotency.key_reused for the second parent's move.
  it('AC-5: with a move of Plants’ children held open, every move button of Plants is disabled and a second click sends nothing; Move up on a child of Quilts sends its own POST under its own key and takes effect; once released, Plants reads b, a, c', async () => {
    const api = fakeApi(SIBLINGS, {
      hold: (s) =>
        s.path === '/api/admin/categories/reorder' &&
        (s.body as { parentId: string | null }).parentId === P.id,
    })
    const user = userEvent.setup()
    renderPage()
    await rowOf(QY.id)

    fireEvent.click(downOf(PA.id))
    await waitFor(() => expect(api.reorders()).toHaveLength(1))
    await waitFor(() => expect(isDisabled(downOf(PB.id))).toBe(true))
    const plantsButtons = [PA, PB, PC].flatMap((c) => [upOf(c.id), downOf(c.id)])
    expect(plantsButtons.map(isDisabled), 'Plants’ move buttons while its move is open').toEqual(
      plantsButtons.map(() => true),
    )
    fireEvent.click(upOf(PC.id))
    fireEvent.click(downOf(PA.id))
    await aTurn()
    expect(api.reorders(), 'reorders while Plants’ is open').toHaveLength(1)

    expect(isDisabled(upOf(QY.id)), 'Quilts’ Move up of Cotton').toBe(false)
    await user.click(upOf(QY.id))
    await waitFor(() => expect(childrenShown(Q)).toEqual([QY.id, QX.id]))

    const [plants, quilts] = api.reorders()
    expect([plants!.body, quilts!.body]).toEqual([
      { parentId: P.id, ids: [PB.id, PA.id, PC.id] },
      { parentId: Q.id, ids: [QY.id, QX.id] },
    ])
    expect(KEY_PATTERN.test(plants!.key ?? ''), `Plants' key ${plants!.key}`).toBe(true)
    expect(KEY_PATTERN.test(quilts!.key ?? ''), `Quilts' key ${quilts!.key}`).toBe(true)
    expect(quilts!.key, 'Quilts’ key').not.toBe(plants!.key)
    expect(text(screen.queryByTestId('admin-categories-error')), 'the page’s alert').toBe('')

    await act(async () => {
      api.release()
    })
    await waitFor(() => expect(childrenShown(P)).toEqual([PB.id, PA.id, PC.id]))
    expect(api.reorders(), 'reorders in all').toHaveLength(2)
  })

  // Kills: an order computed from the list as it first loaded, so each move after the first sends a stale order the
  // server refuses or that undoes an earlier move; a move at the top level sent with a parent.
  it('AC-5: property: any sequence of moves at the top level sends, for each, parentId null and the current order with the row swapped with its neighbour, and the rows then read that order', async () => {
    const roots = fc
      .integer({ min: 2, max: 5 })
      .chain((n) =>
        fc.tuple(
          fc.constant(n),
          fc.array(fc.record({ at: fc.nat(), down: fc.boolean() }), { minLength: 1, maxLength: 4 }),
        ),
      )
    await fc.assert(
      fc.asyncProperty(roots, async ([n, moves]) => {
        const seed = Array.from({ length: n }, (_, i) =>
          category({ id: `cat-r${i}`, name: `Root ${String.fromCharCode(90 - i)}`, position: i }),
        )
        const api = fakeApi(seed)
        const user = userEvent.setup()
        const { unmount } = renderPage()
        try {
          await waitFor(() => expect(rowIds()).toHaveLength(n), { timeout: 5000 })
          const model = seed.map((c) => c.id)
          for (const [i, move] of moves.entries()) {
            // A row that can move that way: never the first up, never the last down.
            const at = move.down ? move.at % (n - 1) : 1 + (move.at % (n - 1))
            const id = model[at]!
            const to = move.down ? at + 1 : at - 1
            ;[model[at], model[to]] = [model[to]!, model[at]!]
            const button = move.down ? downOf(id) : upOf(id)
            await waitFor(() => expect(isDisabled(button)).toBe(false))
            await user.click(button)

            await waitFor(() => expect(api.reorders()).toHaveLength(i + 1))
            expect(api.reorders()[i]!.body, `move ${i + 1}`).toEqual({ parentId: null, ids: model })
            await waitFor(() => expect(rowIds()).toEqual(model))
          }
        } finally {
          unmount()
          vi.unstubAllGlobals()
        }
      }),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 5, endOnFailure: true },
    )
  }, 40_000)
})

// A category with one subcategory and three products.
const TOOLS = category({ id: 'cat-tools', name: 'Tools', position: 2 })
const SPADES = category({ id: 'cat-spades', name: 'Spades', parentId: TOOLS.id })

describe('a delete says what it does and is reported as the server answered it', () => {
  // Kills: a delete with no warning that its products leave the category; a Cancel that deletes.
  it('AC-6: Delete asks "Delete <name>?" and says its products stay in the store and leave it and its subcategories move up; Cancel closes it and sends nothing', async () => {
    const api = fakeApi([GARDEN, TOOLS, SPADES], { products: { [TOOLS.id]: 3 } })
    const user = userEvent.setup()
    renderPage()
    await rowOf(SPADES.id)

    await user.click(deleteOf(TOOLS.id))
    const ask = await screen.findByTestId('admin-category-delete-dialog')
    const said = (ask.textContent ?? '').replace(/\s+/g, ' ')
    expect(
      [`Delete ${TOOLS.name}?`, ...DELETE_TEXT].filter((sentence) => !said.includes(sentence)),
      `the dialog reads: ${said}`,
    ).toEqual([])
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByTestId('admin-category-delete-dialog')).toBeNull())
    await aTurn()
    expect(api.writes(), 'writes sent').toEqual([])
    expect(rowIds()).toContain(TOOLS.id)
  })

  // Kills: a result made up by the page instead of the server's counts; a list or a product page left showing a
  // category that is gone.
  it('AC-6: Confirm sends one DELETE; on { detachedProducts: 3, movedChildren: 1 } the result reads "Deleted <name>: 3 products left it, 1 subcategories moved up", the list is read again with the row gone and its child at depth 0, and the products queries are invalidated', async () => {
    const api = fakeApi([GARDEN, TOOLS, SPADES], { products: { [TOOLS.id]: 3 } })
    const user = userEvent.setup()
    const { queryClient } = renderPage()
    await rowOf(SPADES.id)
    const PRODUCT_KEYS = [
      ['products', 'list', {}],
      ['products', 'detail', 'linen-shirt'],
    ]
    for (const key of PRODUCT_KEYS) queryClient.setQueryData(key, { cached: true })
    const invalidated = () =>
      PRODUCT_KEYS.map((key) => queryClient.getQueryState(key)?.isInvalidated ?? null)
    expect(invalidated(), 'the products queries before').toEqual([false, false])
    const readsBefore = api.listGets().length

    await user.click(deleteOf(TOOLS.id))
    await user.click(await screen.findByTestId('admin-category-delete-confirm'))

    await waitFor(() =>
      expect(resultText()).toBe(
        `Deleted ${TOOLS.name}: 3 products left it, 1 subcategories moved up`,
      ),
    )
    expect(api.writes().map((w) => [w.method, w.path])).toEqual([
      ['DELETE', `/api/admin/categories/${TOOLS.id}`],
    ])
    expect(api.listGets().length, 'list reads after the delete').toBeGreaterThan(readsBefore)
    await waitFor(() => expect(screen.queryByTestId(`${ROW}${TOOLS.id}`)).toBeNull())
    expect(depthOf(SPADES.id), 'the subcategory moved up').toBe('0')
    expect(invalidated(), 'the products queries after').toEqual([true, true])
  })

  // Kills: a confirm that sends a DELETE per click, the second answered 404 and shown as a failure.
  it('AC-6: Confirm clicked twice with the DELETE held open sends one DELETE; once answered the row is gone and no error shows', async () => {
    const api = fakeApi([GARDEN, TOOLS, SPADES], {
      hold: (s) => s.method === 'DELETE',
      products: { [TOOLS.id]: 3 },
    })
    const user = userEvent.setup()
    renderPage()
    await rowOf(SPADES.id)

    await user.click(deleteOf(TOOLS.id))
    const confirm = await screen.findByTestId('admin-category-delete-confirm')
    act(() => {
      confirm.click()
      confirm.click()
    })
    await waitFor(() => expect(api.of('DELETE')).toHaveLength(1))
    const still = screen.queryByTestId('admin-category-delete-confirm')
    if (still !== null) fireEvent.click(still)
    await aTurn()

    expect(api.of('DELETE'), 'DELETEs while the first is open').toHaveLength(1)
    await act(async () => {
      api.release()
    })
    await waitFor(() => expect(screen.queryByTestId(`${ROW}${TOOLS.id}`)).toBeNull())
    expect(api.of('DELETE').map((d) => d.path)).toEqual([`/api/admin/categories/${TOOLS.id}`])
    expect(resultText()).toBe(`Deleted ${TOOLS.name}: 3 products left it, 1 subcategories moved up`)
    expect(text(screen.queryByTestId('admin-categories-error')), 'the page’s alert').toBe('')
  })
})
