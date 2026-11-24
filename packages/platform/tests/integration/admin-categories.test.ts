import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_DELETED,
  EVT_CATEGORY_UPDATED,
  EVT_PRODUCT_UPDATED,
  type Category,
} from '@nymbalhq/types'
import { adminSession, IDEMPOTENCY_KEY, type AdminSession } from '../support/audit-http.js'
import { eventsAfter, payloadOf } from '../support/correlation.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'

// The admin category routes over HTTP on a served kernel (SQLite), with the projections running: what an admin asks
// for is answered, stored and, once the relay has delivered, served by the storefront's reads.

interface ProductDoc {
  id: string
  slug: string
  categories: Array<{ id: string; slug: string; name: string }>
}

interface DeleteAnswer {
  ok: true
  detachedProducts: number
  movedChildren: number
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminSession

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminSession(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

const tag = () => randomUUID().slice(0, 8)

/** A category made through the service, as the importer makes them, so a test's red is the route it is about. */
async function seedCategory(
  over: { parentId?: string | null; position?: number; name?: string } = {},
): Promise<Category> {
  const t = tag()
  return k.services.category.create({ slug: `cat-${t}`, name: over.name ?? `Cat ${t}`, ...over })
}

async function seedProduct(categoryIds: string[]): Promise<{ id: string; slug: string }> {
  const t = tag()
  const product = await k.services.product.create({
    slug: `prod-${t}`,
    name: `Product ${t}`,
    status: 'active',
    categoryIds,
    variants: [
      {
        sku: `CAT-${t}`,
        name: 'Default',
        priceMinor: 1000,
        stock: 5,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  return { id: product.id, slug: product.slug }
}

const drain = () => k.app.relay.drain()

async function adminList(): Promise<Category[]> {
  const res = await admin.send<Category[]>('GET', '/api/admin/categories')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

async function storefrontCategories(): Promise<Category[]> {
  const res = await admin.send<Category[]>('GET', '/api/categories')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

/** The product slugs `GET /api/products?category=` lists under a category slug. */
async function listedUnder(categorySlug: string): Promise<string[]> {
  const res = await admin.send<{ items: Array<{ slug: string }> }>(
    'GET',
    `/api/products?category=${encodeURIComponent(categorySlug)}&limit=100`,
  )
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!.items.map((p) => p.slug).sort()
}

async function servedProduct(slug: string): Promise<ProductDoc> {
  const res = await admin.send<ProductDoc>('GET', `/api/products/${slug}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

async function storedRow(id: string) {
  return raw.one<Record<string, unknown>>('SELECT * FROM categories WHERE id = ?', [id])
}

/** The ids of the logged events of `type` after `seq` whose payload names one of `ids` by `idOf`. */
async function eventIdsAfter(
  seq: number,
  type: string,
  idOf: (payload: Record<string, unknown>) => unknown,
): Promise<string[]> {
  return (await eventsAfter(raw, seq))
    .filter((row) => row.type === type)
    .map((row) => String(idOf(payloadOf(row))))
}

const categoryIdOf = (p: Record<string, unknown>) => (p['category'] as Category).id
const productIdOf = (p: Record<string, unknown>) => (p['product'] as { id: string }).id

describe('admin categories: delete', () => {
  it('AC-4: after DELETE the storefront lists neither the category nor any product under it, its children sit under its former parent, and its products keep and are listed under their other categories', async () => {
    const parent = await seedCategory()
    const target = await seedCategory({ parentId: parent.id })
    const children = [
      await seedCategory({ parentId: target.id }),
      await seedCategory({ parentId: target.id }),
    ]
    const other = await seedCategory()
    const both = await seedProduct([target.id, other.id])
    const only = await seedProduct([target.id])
    await drain()
    expect(await listedUnder(target.slug), 'listed before the delete').toEqual(
      [both.slug, only.slug].sort(),
    )

    const res = await admin.send<DeleteAnswer>('DELETE', `/api/admin/categories/${target.id}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ ok: true, detachedProducts: 2, movedChildren: 2 })
    await drain()

    const storefront = await storefrontCategories()
    expect(storefront.filter((c) => c.id === target.id)).toEqual([])
    expect(children.map((child) => storefront.find((c) => c.id === child.id)?.parentId)).toEqual(
      children.map(() => parent.id),
    )
    expect(await listedUnder(target.slug)).toEqual([])
    expect((await servedProduct(both.slug)).categories.map((c) => c.id)).toEqual([other.id])
    expect((await servedProduct(only.slug)).categories.map((c) => c.id)).toEqual([])
    expect(await listedUnder(other.slug)).toEqual([both.slug])
  })

  it('AC-8: k = 2-4 concurrent DELETEs with one Idempotency-Key detach each product once, publish one category.deleted, and answer alike', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (n) => {
        const target = await seedCategory()
        const products = [await seedProduct([target.id]), await seedProduct([target.id])]
        await drain()
        const before = await maxSeq(raw)
        const key = `cat-delete.${randomUUID()}`

        const answers = await Promise.all(
          Array.from({ length: n }, () =>
            admin.send<DeleteAnswer>('DELETE', `/api/admin/categories/${target.id}`, undefined, {
              [IDEMPOTENCY_KEY]: key,
            }),
          ),
        )
        const context = JSON.stringify(answers.map((a) => [a.status, a.replayed, a.body]))

        expect(
          answers.map((a) => a.status),
          context,
        ).toEqual(answers.map(() => 200))
        expect(
          answers.map((a) => a.body.data),
          context,
        ).toEqual(answers.map(() => ({ ok: true, detachedProducts: 2, movedChildren: 0 })))
        const deleted = await eventIdsAfter(before, EVT_CATEGORY_DELETED, (p) => p['categoryId'])
        expect(deleted, context).toEqual([target.id])
        const updated = (await eventIdsAfter(before, EVT_PRODUCT_UPDATED, productIdOf)).sort()
        expect(updated, context).toEqual(products.map((p) => p.id).sort())
      }),
      { numRuns: 4 },
    )
  }, 60_000)
})

describe('admin categories: reorder', () => {
  it('AC-5: property: for any permutation of one parent’s n children, reorder answers them in that order at 0..n-1, the admin list keeps that order, and one category.updated goes out per child whose position changed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }).chain((n) =>
          fc.record({
            initial: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: n, maxLength: n }),
            order: fc.shuffledSubarray(
              Array.from({ length: n }, (_, i) => i),
              { minLength: n, maxLength: n },
            ),
          }),
        ),
        async ({ initial, order }) => {
          const parent = await seedCategory()
          const children: Category[] = []
          for (const position of initial) {
            children.push(await seedCategory({ parentId: parent.id, position }))
          }
          const ids = order.map((i) => children[i]!.id)
          const before = await maxSeq(raw)

          const res = await admin.send<Category[]>('POST', '/api/admin/categories/reorder', {
            parentId: parent.id,
            ids,
          })

          const context = JSON.stringify({ initial, order, answer: res.body })
          expect(res.status, context).toBe(200)
          expect(
            res.body.data!.map((c) => c.id),
            context,
          ).toEqual(ids)
          expect(
            res.body.data!.map((c) => c.position),
            context,
          ).toEqual(ids.map((_, at) => at))
          const listed = (await adminList()).filter((c) => ids.includes(c.id)).map((c) => c.id)
          expect(listed, context).toEqual(ids)
          const changed = order
            .filter((child, at) => initial[child] !== at)
            .map((child) => children[child]!.id)
            .sort()
          const updated = (await eventIdsAfter(before, EVT_CATEGORY_UPDATED, categoryIdOf)).sort()
          expect(updated, context).toEqual(changed)
        },
      ),
      { numRuns: 10 },
    )
  }, 60_000)

  it('AC-5: ids that omit a child, repeat one, or name another parent’s child are 400 category.reorder_mismatch and change no position', async () => {
    const parent = await seedCategory()
    const [a, b, c] = [
      await seedCategory({ parentId: parent.id, position: 2 }),
      await seedCategory({ parentId: parent.id, position: 0 }),
      await seedCategory({ parentId: parent.id, position: 1 }),
    ]
    const elsewhere = await seedCategory({ parentId: (await seedCategory()).id })
    const positions = () =>
      raw.rows<{ id: string; position: number }>(
        'SELECT id, position FROM categories WHERE parent_id IN (?, ?) ORDER BY id',
        [parent.id, elsewhere.parentId],
      )
    const stored = await positions()
    const before = await maxSeq(raw)
    const mismatched = [
      [a.id, b.id],
      [a.id, b.id, c.id, a.id],
      [a.id, b.id, elsewhere.id],
      [a.id, b.id, c.id, elsewhere.id],
    ]

    const answers = []
    for (const ids of mismatched) {
      const res = await admin.send('POST', '/api/admin/categories/reorder', {
        parentId: parent.id,
        ids,
      })
      answers.push([res.status, res.body.error?.code])
    }

    expect(answers).toEqual(mismatched.map(() => [400, 'category.reorder_mismatch']))
    expect(await positions()).toEqual(stored)
    expect(await eventIdsAfter(before, EVT_CATEGORY_UPDATED, categoryIdOf)).toEqual([])
  })
})

describe('admin categories: create and update', () => {
  it('AC-6: POST answers 201 with the category, which the admin list holds at once and the storefront lists once projected', async () => {
    const parent = await seedCategory()
    const body = {
      slug: `summer-${tag()}`,
      name: 'Summer',
      description: 'Hot days',
      parentId: parent.id,
      position: 4,
    }

    const res = await admin.send<Category>('POST', '/api/admin/categories', body)

    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const created = res.body.data!
    expect(created).toMatchObject(body)
    expect((await adminList()).find((c) => c.id === created.id)).toEqual(created)
    await drain()
    const projected = (await storefrontCategories()).find((c) => c.id === created.id)
    expect(projected && { slug: projected.slug, parentId: projected.parentId }).toEqual({
      slug: created.slug,
      parentId: created.parentId,
    })
  })

  it('AC-6: property: a slug of lowercase letters and digits in single-hyphen runs, up to 80 long, is created as sent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(SLUG).filter((s) => s.length <= 71),
        async (stem) => {
          const slug = `${stem}-${tag()}`
          const res = await admin.send<Category>('POST', '/api/admin/categories', {
            slug,
            name: 'Generated',
          })
          expect(res.status, JSON.stringify({ slug, answer: res.body })).toBe(201)
          expect(res.body.data!.slug).toBe(slug)
          expect(await raw.count('categories', 'slug = ?', [slug])).toBe(1)
        },
      ),
      { numRuns: 12 },
    )
    const longest = `${'a'.repeat(71)}-${tag()}`
    expect(longest.length).toBe(80)
    const res = await admin.send('POST', '/api/admin/categories', { slug: longest, name: 'Long' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  }, 60_000)

  it('AC-6: a taken slug, a slug no URL rule allows, a blank name, a long description, a bad position and an unknown parent are each 400 and create nothing', async () => {
    const taken = await seedCategory()
    const before = await raw.count('categories')
    const t = tag()
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ slug: 'Shoes', name: 'Shoes' }, 'validation.failed'],
      [{ slug: `a--b${t}`, name: 'Double' }, 'validation.failed'],
      [{ slug: `-a${t}`, name: 'Leading' }, 'validation.failed'],
      [{ slug: `a${t}-`, name: 'Trailing' }, 'validation.failed'],
      [{ slug: `${'b'.repeat(72)}-${t}`, name: 'Long' }, 'validation.failed'],
      [{ slug: `blank-${t}`, name: '   ' }, 'validation.failed'],
      [{ slug: `wordy-${t}`, name: 'Wordy', description: 'x'.repeat(2001) }, 'validation.failed'],
      [{ slug: `minus-${t}`, name: 'Minus', position: -1 }, 'validation.failed'],
      [{ slug: `half-${t}`, name: 'Half', position: 1.5 }, 'validation.failed'],
      [{ slug: `orphan-${t}`, name: 'Orphan', parentId: randomUUID() }, 'category.parent_unknown'],
    ]

    const answers = []
    for (const [body] of refused) {
      const res = await admin.send('POST', '/api/admin/categories', body)
      answers.push([res.status, res.body.error?.code])
    }
    const dup = await admin.send('POST', '/api/admin/categories', {
      slug: taken.slug,
      name: 'Again',
    })

    expect(answers).toEqual(refused.map(([, code]) => [400, code]))
    expect([dup.status, dup.body.error?.code]).toEqual([400, 'validation.failed'])
    expect(dup.body.error?.message).toContain(taken.slug)
    expect(await raw.count('categories')).toBe(before)
  })

  it('AC-6: PATCH changes name, description, parent and position and answers the stored row', async () => {
    const category = await seedCategory()
    const parent = await seedCategory()
    const patch = { name: 'Renamed', description: 'Moved here', parentId: parent.id, position: 7 }

    const res = await admin.send<Category>('PATCH', `/api/admin/categories/${category.id}`, patch)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ ...category, ...patch })
    expect((await adminList()).find((c) => c.id === category.id)).toEqual(res.body.data)
  })

  it('AC-6: PATCH refuses a slug, a blank name, a 2001-character description, position -1, an unknown parent and a descendant parent, changing nothing, and an unknown id is 404', async () => {
    const category = await seedCategory()
    const child = await seedCategory({ parentId: category.id })
    const stored = await storedRow(category.id)
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ slug: `renamed-${tag()}` }, 'validation.failed'],
      [{ name: '  ' }, 'validation.failed'],
      [{ description: 'x'.repeat(2001) }, 'validation.failed'],
      [{ position: -1 }, 'validation.failed'],
      [{ parentId: randomUUID() }, 'category.parent_unknown'],
      [{ parentId: category.id }, 'category.parent_cycle'],
      [{ parentId: child.id }, 'category.parent_cycle'],
    ]

    const answers = []
    for (const [body] of refused) {
      const res = await admin.send('PATCH', `/api/admin/categories/${category.id}`, body)
      answers.push([res.status, res.body.error?.code])
    }
    const unknown = await admin.send('PATCH', `/api/admin/categories/${randomUUID()}`, {
      name: 'Ghost',
    })

    expect(answers).toEqual(refused.map(([, code]) => [400, code]))
    expect(await storedRow(category.id)).toEqual(stored)
    expect([unknown.status, unknown.body.error?.code]).toEqual([404, 'not_found'])
  })

  it('AC-8: k = 2-4 concurrent POSTs with one Idempotency-Key and one body make one category and one category.created, and every answer carries its id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 4 }), async (n) => {
        const slug = `once-${tag()}`
        const key = `cat-create.${randomUUID()}`
        const before = await maxSeq(raw)

        const answers = await Promise.all(
          Array.from({ length: n }, () =>
            admin.send<Category>(
              'POST',
              '/api/admin/categories',
              { slug, name: 'Once' },
              { [IDEMPOTENCY_KEY]: key },
            ),
          ),
        )
        const context = JSON.stringify(answers.map((a) => [a.status, a.replayed, a.body]))

        expect(await raw.count('categories', 'slug = ?', [slug]), context).toBe(1)
        const { id } = await raw.one<{ id: string }>('SELECT id FROM categories WHERE slug = ?', [
          slug,
        ])
        expect(
          answers.map((a) => [a.status, a.body.data?.id]),
          context,
        ).toEqual(answers.map(() => [201, id]))
        expect(await eventIdsAfter(before, EVT_CATEGORY_CREATED, categoryIdOf), context).toEqual([
          id,
        ])
      }),
      { numRuns: 4 },
    )
  }, 60_000)
})
