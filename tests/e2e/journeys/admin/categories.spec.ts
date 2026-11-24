import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { signInAsAdmin } from '../../support/admin'
import { adminToken, ownProduct } from '../../support/checkout'
import { API_URL, csrf } from '../../support/csrf'
import {
  cancelDialog,
  expectInside,
  over,
  secondClickOnceOpen,
  signInByForm,
  watchWrites,
} from '../../support/dialog-clicks'
import { phoneWidths } from '../../support/phone-width'

// The merchant keeps the store's categories on /admin/categories and a product's on its page; what the admin shows is
// what the storefront's routes then serve. Every category and product here is the journey's own, tagged per run.

interface ListedCategory {
  id: string
  parentId: string | null
  name: string
  slug: string
  position: number
}

const PREFIX = '/api/admin/categories'

async function adminCategories(
  request: APIRequestContext,
  token: string,
): Promise<ListedCategory[]> {
  const res = await request.get(`${API_URL}${PREFIX}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET ${PREFIX}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ListedCategory[] }).data
}

/** What the storefront reads: `GET /api/categories`, in its order. */
async function storeCategories(request: APIRequestContext): Promise<ListedCategory[]> {
  const res = await request.get(`${API_URL}/api/categories`)
  expect(res.status(), `GET /api/categories: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: ListedCategory[] }).data
}

async function makeCategory(
  request: APIRequestContext,
  token: string,
  name: string,
  parentId: string | null = null,
): Promise<ListedCategory> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const res = await request.post(`${API_URL}${PREFIX}`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: { slug, name, parentId },
  })
  expect(res.status(), `POST ${PREFIX}: ${await res.text()}`).toBe(201)
  return ((await res.json()) as { data: ListedCategory }).data
}

/** The ids of `ids` in the order a list gives them. */
const orderOf = (list: ListedCategory[], ids: string[]) =>
  list.filter((c) => ids.includes(c.id)).map((c) => c.id)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Picks the parent on the dialog's parent control: a native select, or a listbox its trigger opens. */
async function chooseParent(page: Page, name: string): Promise<void> {
  const control = page.getByTestId('admin-category-parent')
  const named = new RegExp(`^[^\\p{L}\\p{N}]*${escape(name)}$`, 'u')
  if ((await control.evaluate((el) => el.tagName)) === 'SELECT') {
    const value = await control.evaluate(
      (el, source) =>
        [...(el as HTMLSelectElement).options].find((o) =>
          new RegExp(source, 'u').test(o.textContent?.trim() ?? ''),
        )?.value ?? null,
      named.source,
    )
    expect(value, `the parent select offers ${name}`).not.toBeNull()
    await control.selectOption(value!)
  } else {
    await control.click()
    await page.getByRole('option', { name: named }).click()
  }
}

/** Opens the New dialog, names the category and, when given, its parent. */
async function fillNew(page: Page, name: string, parent?: string): Promise<void> {
  await page.getByTestId('admin-categories-new').click({ timeout: 15_000 })
  await expect(page.getByTestId('admin-category-dialog')).toBeVisible()
  await page.getByTestId('admin-category-name').fill(name)
  if (parent !== undefined) await chooseParent(page, parent)
}

const isReorder = (pathname: string) => pathname === `${PREFIX}/reorder`

test.describe('The merchant keeps the store’s categories', () => {
  // Kills: no page (fails on base); a double-clicked Save that makes two categories; a delete that leaves the product
  // listed under a category that is gone, or its subcategory under nothing.
  test('AC-9: a category made with Save double-clicked is one category in the admin and the storefront; a subcategory made under it through the parent select sits at depth 1; a product checked into it on its page is listed under it; deleting it names 1 product and 1 subcategory, takes it from the storefront, moves the subcategory to the top and leaves the product without it', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8)
    const name = `E2E Cat ${tag}`
    const slug = `e2e-cat-${tag}`
    const subName = `E2E Sub ${tag}`

    await signInAsAdmin(page)
    await page.goto('categories')
    await fillNew(page, name)
    await expect(page.getByTestId('admin-category-slug')).toHaveValue(slug)
    const posts = watchWrites(page, 'POST', PREFIX)
    await page.getByTestId('admin-category-save').dblclick()
    await posts.settled()
    await expect(page.getByTestId('admin-categories-result')).toHaveText(`Created ${name}`, {
      timeout: 15_000,
    })
    await expect(page.getByTestId('admin-category-error')).toHaveCount(0)
    const made = (await adminCategories(request, token)).filter((c) => c.slug === slug)
    expect(
      made.map((c) => c.name),
      `categories of ${slug} after ${posts.sent()} POSTs`,
    ).toEqual([name])
    const first = made[0]!
    await expect
      .poll(async () => (await storeCategories(request)).filter((c) => c.slug === slug).length, {
        message: 'GET /api/categories lists it',
        timeout: 10_000,
      })
      .toBe(1)

    await fillNew(page, subName, name)
    await page.getByTestId('admin-category-save').click()
    await expect(page.getByTestId('admin-categories-result')).toHaveText(`Created ${subName}`, {
      timeout: 15_000,
    })
    const sub = (await adminCategories(request, token)).find((c) => c.name === subName)
    expect(sub?.parentId, 'the subcategory’s parentId').toBe(first.id)
    await expect(page.getByTestId(`admin-categories-row-${sub!.id}`)).toHaveAttribute(
      'data-depth',
      '1',
    )

    const product = await ownProduct(request, token, 5)
    await page.goto(`products/${product.slug}`)
    const box = page.getByTestId(`admin-product-category-${first.id}`)
    await box.click({ timeout: 15_000 })
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await page.getByTestId('admin-product-save').click()
    await expect(page.getByText('Unsaved changes')).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/products?category=${slug}&limit=100`)
          const body = (await res.json()) as { data: { items: Array<{ slug: string }> } }
          return body.data.items.map((p) => p.slug)
        },
        { message: `GET /api/products?category=${slug}`, timeout: 10_000 },
      )
      .toEqual([product.slug])

    await page.goto('categories')
    await page.getByTestId(`admin-categories-delete-${first.id}`).click({ timeout: 15_000 })
    await page.getByTestId('admin-category-delete-confirm').click()
    await expect(page.getByTestId('admin-categories-result')).toHaveText(
      `Deleted ${name}: 1 products left it, 1 subcategories moved up`,
      { timeout: 15_000 },
    )
    await expect
      .poll(
        async () => {
          const listed = await storeCategories(request)
          return {
            first: listed.some((c) => c.id === first.id),
            subParent: listed.find((c) => c.id === sub!.id)?.parentId,
          }
        },
        { message: 'GET /api/categories after the delete', timeout: 10_000 },
      )
      .toEqual({ first: false, subParent: null })
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/products/${product.slug}`)
          const doc = (await res.json()) as {
            data: { categoryIds: string[]; categories: Array<{ id: string }> }
          }
          return [
            doc.data.categoryIds.includes(first.id),
            doc.data.categories.some((c) => c.id === first.id),
          ]
        },
        {
          message: `GET /api/products/${product.slug} names the deleted category`,
          timeout: 10_000,
        },
      )
      .toEqual([false, false])

    await page.goto(`products/${product.slug}`)
    await expect(page.getByTestId(`admin-product-category-${sub!.id}`)).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId(`admin-product-category-${first.id}`)).toHaveCount(0)
  })

  // Kills: buttons that move rows on the page and not in the store.
  test('AC-10: Move down on the first of two siblings under a parent of the journey’s own swaps them in GET /api/categories', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8)
    const parent = await makeCategory(request, token, `E2E Order ${tag}`)
    const x = await makeCategory(request, token, `E2E Order X ${tag}`, parent.id)
    const y = await makeCategory(request, token, `E2E Order Y ${tag}`, parent.id)
    const pair = [x.id, y.id]
    await expect
      .poll(async () => orderOf(await storeCategories(request), pair), {
        message: 'the two as made',
        timeout: 10_000,
      })
      .toEqual([x.id, y.id])

    await signInAsAdmin(page)
    await page.goto('categories')
    await page.getByTestId(`admin-categories-down-${x.id}`).click({ timeout: 15_000 })
    await expect(page.getByTestId('admin-categories-result')).toHaveText(`Moved ${x.name}`, {
      timeout: 15_000,
    })

    await expect
      .poll(async () => orderOf(await storeCategories(request), pair), {
        message: 'GET /api/categories after Move down',
        timeout: 10_000,
      })
      .toEqual([y.id, x.id])
    const rows = await page
      .locator('[data-testid^="admin-categories-row-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
    expect(rows.filter((r) => pair.some((id) => r === `admin-categories-row-${id}`))).toEqual([
      `admin-categories-row-${y.id}`,
      `admin-categories-row-${x.id}`,
    ])
  })

  // Kills: a move whose second click of a double-click acts again, on the row the move brought under the pointer or on
  // the row a cleared result message moved there, so one double-click is two moves.
  test('AC-5: with "Moved <name>" showing above the list, a double-click on a row’s Move down sends one reorder and moves that row one place', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8)
    const parent = await makeCategory(request, token, `E2E Twice ${tag}`)
    const [a, b, c, d] = await (async () => {
      const made: ListedCategory[] = []
      for (const letter of ['A', 'B', 'C', 'D']) {
        made.push(await makeCategory(request, token, `E2E Twice ${letter} ${tag}`, parent.id))
      }
      return made
    })()
    const four = [a!.id, b!.id, c!.id, d!.id]

    await signInAsAdmin(page)
    await page.goto('categories')
    await page.getByTestId(`admin-categories-down-${a!.id}`).click({ timeout: 15_000 })
    await expect(page.getByTestId('admin-categories-result')).toHaveText(`Moved ${a!.name}`, {
      timeout: 15_000,
    })
    await expect(page.getByTestId(`admin-categories-down-${a!.id}`)).toBeEnabled()
    await expect
      .poll(async () => orderOf(await adminCategories(request, token), four), { timeout: 10_000 })
      .toEqual([b!.id, a!.id, c!.id, d!.id])

    const reorders = watchWrites(page, 'POST', PREFIX, isReorder)
    await page.getByTestId(`admin-categories-down-${a!.id}`).dblclick()
    await reorders.settled()
    await expect
      .poll(async () => orderOf(await adminCategories(request, token), four), {
        message: `the order after ${reorders.sent()} reorders`,
        timeout: 10_000,
      })
      .toEqual([b!.id, c!.id, a!.id, d!.id])
    expect(reorders.sent(), 'reorders sent by the double-click').toBe(1)
  })
})

test.describe('Categories at a phone’s width @phone-width', () => {
  // Kills: a long name that widens the page, a row's buttons pushed off the screen, or a dialog whose buttons leave
  // the viewport on a phone.
  test('AC-11: /admin/categories holding a category whose name is one 64-character word, and the product page with that category in its card, are no wider than the viewport; the row’s buttons and its Edit and Delete dialogs stay inside it', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const token = await adminToken(request)
    const word = `W${randomUUID().replace(/-/g, '')}`.padEnd(64, 'x')
    const long = await makeCategory(request, token, word)
    const tag = randomUUID().slice(0, 8)
    const res = await request.post(`${API_URL}/api/admin/products`, {
      headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
      data: {
        slug: `e2e-wide-${tag}`,
        name: `E2E Wide ${tag}`,
        status: 'active',
        categoryIds: [long.id],
        variants: [
          { sku: `WIDE-${tag}`, name: 'Default', priceMinor: 1999, stock: 3, options: [] },
        ],
      },
    })
    expect(res.status(), `POST /api/admin/products: ${await res.text()}`).toBe(201)
    const productSlug = ((await res.json()) as { data: { slug: string } }).data.slug
    const rowId = `admin-categories-row-${long.id}`

    await signInByForm(page)
    await page.goto('categories')
    await expect(page.getByTestId(rowId)).toContainText(word, { timeout: 15_000 })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })
    const listed = await phoneWidths(page, 'categories')
    expect.soft(listed.scrollWidth, listed.measured).toBeLessThanOrEqual(listed.viewport + 1)
    expect.soft(listed.innerWidth, listed.measured).toBe(listed.viewport)

    for (const button of ['up', 'down', 'edit', 'delete'].map(
      (b) => `admin-categories-${b}-${long.id}`,
    )) {
      await page.getByTestId(button).scrollIntoViewIfNeeded()
      const box = await page.getByTestId(button).boundingBox()
      const left = box === null ? Number.NEGATIVE_INFINITY : box.x
      const right = box === null ? Number.POSITIVE_INFINITY : box.x + box.width
      expect
        .soft(
          { left: left >= -1, right: right <= listed.viewport + 1 },
          `${button}: ${left} to ${right}, viewport ${listed.viewport}`,
        )
        .toEqual({ left: true, right: true })
    }

    await page.getByTestId(`admin-categories-edit-${long.id}`).click()
    await expectInside(page, 'admin-category-dialog', 'admin-category-save', listed.viewport)
    await cancelDialog(page, 'admin-category-dialog')
    await page.getByTestId(`admin-categories-delete-${long.id}`).click()
    await expectInside(
      page,
      'admin-category-delete-dialog',
      'admin-category-delete-confirm',
      listed.viewport,
    )
    await cancelDialog(page, 'admin-category-delete-dialog')

    await page.goto(`products/${productSlug}`)
    await expect(page.getByTestId(`admin-product-category-${long.id}`)).toBeVisible({
      timeout: 15_000,
    })
    const product = await phoneWidths(page, 'product with the long category')
    expect(product.scrollWidth, product.measured).toBeLessThanOrEqual(product.viewport + 1)
    expect(product.innerWidth, product.measured).toBe(product.viewport)
  })
})

test.describe('A double-click that opens or closes a category dialog at a phone’s width @phone-width', () => {
  // Kills: a button that acts on the second click of a double-click whose first click opened or closed a dialog over
  // it, so one double-click deletes or saves one category and moves another, or deletes one never confirmed. Under a
  // parent of the journey's own: target, `between` fillers, other, last; other's Move down is live. A category is made
  // at position 0, so siblings list by name: the names sort in the order they are made.
  const family = async (request: APIRequestContext, between = 0) => {
    const token = await adminToken(request)
    const tag = randomUUID().slice(0, 8)
    const parent = await makeCategory(request, token, `E2E Aim ${tag}`)
    const target = await makeCategory(request, token, `E2E Aim A ${tag}`, parent.id)
    for (let i = 0; i < between; i += 1) {
      await makeCategory(request, token, `E2E Aim B${i} ${tag}`, parent.id)
    }
    const other = await makeCategory(request, token, `E2E Aim C ${tag}`, parent.id)
    const last = await makeCategory(request, token, `E2E Aim D ${tag}`, parent.id)
    return { token, target, other, last }
  }

  const open = async (page: Page, target: ListedCategory, other: ListedCategory) => {
    await signInByForm(page)
    await page.goto('categories')
    await expect(page.getByTestId(`admin-categories-row-${other.id}`)).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('main .animate-pulse')).toHaveCount(0, { timeout: 10_000 })
    await page.getByTestId(`admin-categories-delete-${target.id}`).scrollIntoViewIfNeeded()
  }

  test('AC-6: a double-clicked Delete confirm over another row’s Move down sends one DELETE and no reorder; the other rows keep their order', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { token, target, other, last } = await family(request)
    await open(page, target, other)

    await page.getByTestId(`admin-categories-delete-${target.id}`).click()
    const point = await over(
      page,
      'admin-category-delete-dialog',
      'admin-category-delete-confirm',
      `admin-categories-down-${other.id}`,
    )
    const deletes = watchWrites(page, 'DELETE', PREFIX)
    const reorders = watchWrites(page, 'POST', PREFIX, isReorder)
    await page.getByTestId('admin-category-delete-confirm').dblclick({ position: point })
    await expect(page.getByTestId(`admin-categories-row-${target.id}`)).toHaveCount(0, {
      timeout: 10_000,
    })
    await deletes.settled()
    await reorders.settled()
    expect(
      { deletes: deletes.sent(), reorders: reorders.sent() },
      'writes sent by the double-click',
    ).toEqual({ deletes: 1, reorders: 0 })
    const listed = await adminCategories(request, token)
    expect(
      [listed.some((c) => c.id === target.id), orderOf(listed, [other.id, last.id])],
      'target listed; the order of other and last',
    ).toEqual([false, [other.id, last.id]])
  })

  test('AC-4: a double-clicked Edit Save over another row’s Move down, its second click after the save closed the dialog, sends one PATCH and no reorder', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { token, target, other, last } = await family(request, 8)
    await open(page, target, other)

    await page.getByTestId(`admin-categories-edit-${target.id}`).click()
    const point = await over(
      page,
      'admin-category-dialog',
      'admin-category-save',
      `admin-categories-down-${other.id}`,
    )
    const save = await page.getByTestId('admin-category-save').boundingBox()
    const x = save!.x + point.x
    const y = save!.y + point.y
    const patches = watchWrites(page, 'PATCH', PREFIX)
    const reorders = watchWrites(page, 'POST', PREFIX, isReorder)
    // A local write answers within a double-click's interval: the second click comes once the dialog has closed.
    await page.mouse.move(x, y)
    await page.mouse.down({ clickCount: 1 })
    await page.mouse.up({ clickCount: 1 })
    await expect(page.getByTestId('admin-category-dialog')).toHaveCount(0, { timeout: 10_000 })
    await page.mouse.down({ clickCount: 2 })
    await page.mouse.up({ clickCount: 2 })
    await patches.settled()
    await reorders.settled()
    expect(
      { patches: patches.sent(), reorders: reorders.sent() },
      'writes sent by the double-click',
    ).toEqual({ patches: 1, reorders: 0 })
    await expect(page.getByTestId('admin-categories-result')).toHaveText(`Saved ${target.name}`)
    expect(orderOf(await adminCategories(request, token), [other.id, last.id])).toEqual([
      other.id,
      last.id,
    ])
  })

  test('AC-6: a double-clicked row Delete under where its confirm opens leaves the confirm open and sends no DELETE', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { token, target, other } = await family(request)
    await open(page, target, other)

    const del = `admin-categories-delete-${other.id}`
    await page.getByTestId(del).click()
    await over(page, 'admin-category-delete-dialog', 'admin-category-delete-confirm', del)
    await cancelDialog(page, 'admin-category-delete-dialog')
    const deletes = watchWrites(page, 'DELETE', PREFIX)
    await secondClickOnceOpen(page, del, 'admin-category-delete-dialog')
    await deletes.settled()
    expect(deletes.sent(), 'DELETEs sent by the double-click').toBe(0)
    await expect(page.getByTestId('admin-category-delete-dialog')).toBeVisible()
    expect((await adminCategories(request, token)).map((c) => c.id)).toContain(other.id)
  })

  test('AC-4: a double-clicked row Edit under where its Save opens leaves the dialog open and sends no PATCH', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { target, other } = await family(request, 8)
    await open(page, target, other)

    const edit = `admin-categories-edit-${other.id}`
    await page.getByTestId(edit).click()
    await over(page, 'admin-category-dialog', 'admin-category-save', edit)
    await cancelDialog(page, 'admin-category-dialog')
    const patches = watchWrites(page, 'PATCH', PREFIX)
    await secondClickOnceOpen(page, edit, 'admin-category-dialog')
    await patches.settled()
    expect(patches.sent(), 'PATCHes sent by the double-click').toBe(0)
    await expect(page.getByTestId('admin-category-dialog')).toBeVisible()
    expect(
      (await page.getByTestId('admin-categories-result').allTextContents()).join('').trim(),
      'the outcome line',
    ).toBe('')
  })
})
