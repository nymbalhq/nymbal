import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Product, ProductStatus } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Dialect, Kernel } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'
import { openRaw, writeRaw, type RawReader } from '../raw.js'

// The admin products list searched by name on one dialect, through the served kernel's route. Every product a test
// searches for is made after a run of products longer than the route's old window (limit + offset + 200 rows), so a
// search over a window of the table cannot find it.

export interface AdminProductsSearchOptions {
  /** A kernel on a database of its own. */
  open(): Promise<Kernel>
  propertyRuns: number
}

/** More rows than the old window reads at the route's default limit (50 + 200). */
const FILLER = 260

export function adminProductsSearchSuite(
  dialect: Dialect,
  options: AdminProductsSearchOptions,
): void {
  describe(`admin products search by name (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminClient
    let raw: RawReader
    /** The product made before the filler, by name. */
    const beforeFiller = `Solstice Sandal ${randomUUID().slice(0, 8)}`
    let beforeFillerId: string

    const makeProduct = async (name: string, status: ProductStatus = 'active') => {
      const product = await k.services.product.create({
        slug: `search-${randomUUID()}`,
        name,
        description: '',
        status,
        variants: [
          {
            sku: `SEARCH-${randomUUID()}`,
            name: 'Default',
            priceMinor: 1000,
            stock: 1,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
      return product.id
    }

    beforeAll(async () => {
      k = await options.open()
      served = await serveKernel(k)
      admin = await adminClient(k, served.baseUrl)
      raw = openRaw(k.dialect, k.target)
      beforeFillerId = await makeProduct(beforeFiller)
      for (let i = 0; i < FILLER; i += 1) await makeProduct(`Filler ${i}`)
    }, 120_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function search(query: Record<string, string | number>): Promise<Product[]> {
      const params = new URLSearchParams(Object.entries(query).map(([q, v]) => [q, String(v)]))
      const res = await admin.call<Product[]>('GET', `/api/admin/products?${params.toString()}`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!
    }

    const namesOf = (products: Product[]) => products.map((p) => p.name).sort()

    it(`AC-12: GET /api/admin/products?q= returns a match with more products than the old window created after it, and a match created after those (${dialect})`, async () => {
      const tag = beforeFiller.split(' ').at(-1)!
      const afterFiller = `Solstice Sandal Second ${tag}`
      const afterFillerId = await makeProduct(afterFiller)

      const found = await search({ q: `solstice sandal`, limit: 2 })

      expect(found.map((p) => p.id)).toEqual([beforeFillerId, afterFillerId])
    }, 60_000)

    it(`AC-13: q matches case-insensitively, takes % and _ as themselves, and combines with status (${dialect})`, async () => {
      const tag = randomUUID().slice(0, 8)
      await makeProduct(`100% Cotton ${tag}`)
      await makeProduct(`100 Cotton ${tag}`)
      await makeProduct(`under_score ${tag}`)
      await makeProduct(`underXscore ${tag}`)
      await makeProduct(`Lamp Active ${tag}`, 'active')
      await makeProduct(`Lamp Draft ${tag}`, 'draft')
      await makeProduct(`Élan Mug ${tag}`)
      await makeProduct(`écru Scarf ${tag}`)

      expect(namesOf(await search({ q: `élan mug ${tag}` }))).toEqual([`Élan Mug ${tag}`])
      expect(namesOf(await search({ q: `ÉCRU SCARF ${tag}` }))).toEqual([`écru Scarf ${tag}`])
      expect(namesOf(await search({ q: `100% cotton ${tag}` }))).toEqual([`100% Cotton ${tag}`])
      expect(namesOf(await search({ q: `100 COTTON ${tag}` }))).toEqual([`100 Cotton ${tag}`])
      expect(namesOf(await search({ q: `under_score ${tag}` }))).toEqual([`under_score ${tag}`])
      expect(namesOf(await search({ q: `UNDER_SCORE ${tag.toUpperCase()}` }))).toEqual([
        `under_score ${tag}`,
      ])
      expect(namesOf(await search({ q: `lamp`, status: 'active' }))).toEqual([`Lamp Active ${tag}`])
      expect(namesOf(await search({ q: `lamp`, status: 'draft' }))).toEqual([`Lamp Draft ${tag}`])
      expect(namesOf(await search({ q: `lamp` }))).toEqual([
        `Lamp Active ${tag}`,
        `Lamp Draft ${tag}`,
      ])
    }, 60_000)

    it(`AC-14: property: walking q with any limit and successive offsets returns each match exactly once, in createdAt then id order, the same on every walk (${dialect})`, async () => {
      const tag = randomUUID().slice(0, 8)
      const ids: string[] = []
      for (let i = 0; i < 7; i += 1) ids.push(await makeProduct(`Walk ${tag} ${i}`))
      // Rows sharing an instant, so the order among them rests on the id.
      const tied = ids.slice(1, 4)
      const { created_at: first } = await raw.one<{ created_at: unknown }>(
        'SELECT created_at FROM products WHERE id = ?',
        [tied[0]],
      )
      await writeRaw(
        k.dialect,
        k.target,
        `UPDATE products SET created_at = ? WHERE id IN (${tied.map(() => '?').join(', ')})`,
        [new Date(first as string | Date).toISOString(), ...tied],
      )
      const stored = await raw.rows<{ id: string; created_at: unknown }>(
        `SELECT id, created_at FROM products WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids,
      )
      const instant = (r: { created_at: unknown }) =>
        new Date(r.created_at as string | Date).getTime()
      const expected = [...stored]
        .sort((a, b) => instant(a) - instant(b) || (a.id < b.id ? -1 : 1))
        .map((r) => r.id)

      const walk = async (limit: number): Promise<string[]> => {
        const out: string[] = []
        for (let offset = 0; offset < 40; offset += limit) {
          const page = await search({ q: `walk ${tag}`, limit, offset })
          if (page.length === 0) break
          out.push(...page.map((p) => p.id))
        }
        return out
      }

      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (limit) => {
          expect(await walk(limit)).toEqual(expected)
          expect(await walk(limit)).toEqual(expected)
        }),
        { numRuns: options.propertyRuns },
      )
    }, 120_000)
  })
}
