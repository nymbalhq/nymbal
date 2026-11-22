import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProductSnapshot } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { openRaw } from '../support/raw.js'

// Duplicating a product through the admin route on SQLite: every copy a draft with the first free slug and SKUs, no
// stock of its own, the original untouched. Each property run builds a store of its own, so "every product in the
// store" is the original and its copies.

interface VariantSeed {
  stock: number
  taxCode: string | null
}

interface Store {
  k: Kernel
  served: ServedKernel
  admin: AdminClient
}

async function openStore(): Promise<Store> {
  const k = await createKernel({ dialect: 'sqlite' })
  const served = await serveKernel(k)
  const admin = await adminClient(k, served.baseUrl)
  return { k, served, admin }
}

async function seedProduct(
  k: Kernel,
  slug: string,
  skuBase: string,
  variants: VariantSeed[],
): Promise<ProductSnapshot> {
  return k.services.product.create({
    slug,
    name: `Linen Shirt ${slug}`,
    description: 'A shirt.',
    status: 'active',
    type: variants.length > 1 ? 'variable' : 'simple',
    variants: variants.map((v, i) => ({
      sku: `${skuBase}-${i}`,
      name: `Size ${i}`,
      priceMinor: 2500 + i,
      stock: v.stock,
      lowStockThreshold: 1,
      options: [{ name: 'Size', value: `S${i}` }],
      taxCode: v.taxCode,
    })),
  })
}

async function duplicate(admin: AdminClient, id: string) {
  return admin.call<ProductSnapshot>('POST', `/api/admin/products/${id}/duplicate`, {})
}

/** The suffix copy k takes: `-copy` for the first, `-copy-<k>` after; SKUs the same in capitals. */
const slugSuffix = (k: number) => (k === 1 ? '-copy' : `-copy-${k}`)
const skuSuffix = (k: number) => (k === 1 ? '-COPY' : `-COPY-${k}`)

async function totalStock(k: Kernel): Promise<number> {
  const raw = openRaw(k.dialect, k.target)
  try {
    const { total } = await raw.one<{ total: number | null }>(
      'SELECT SUM(stock) AS total FROM variants',
    )
    return Number(total ?? 0)
  } finally {
    await raw.close()
  }
}

const shape = (p: ProductSnapshot) => ({
  slug: p.slug,
  variants: p.variants
    .map((v) => ({ sku: v.sku, stock: v.stock, taxCode: v.taxCode ?? null }))
    .sort((a, b) => a.sku.localeCompare(b.sku)),
})

describe('duplicating a product from the admin (sqlite)', () => {
  it("AC-1: property: n duplicates in a row each make a draft \"(Copy)\" with the next free suffix on slug and SKUs, no stock and the original's tax codes; the original is unchanged and the store's total stock is still the original's", async () => {
    const scenario = fc.record({
      variants: fc.array(
        fc.record({
          stock: fc.integer({ min: 0, max: 60 }),
          taxCode: fc.constantFrom(null, 'standard', 'reduced', 'zero-rated'),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      n: fc.integer({ min: 1, max: 5 }),
      slugTail: fc.constantFrom('', '-copy'),
    })

    await fc.assert(
      fc.asyncProperty(scenario, async ({ variants, n, slugTail }) => {
        const { k, served, admin } = await openStore()
        try {
          const tag = randomUUID().slice(0, 8)
          const original = await seedProduct(k, `shirt-${tag}${slugTail}`, `SHIRT-${tag}`, variants)
          const before = shape(original)
          const stockBefore = await totalStock(k)
          expect(stockBefore, 'the store holds only the original').toBe(
            variants.reduce((sum, v) => sum + v.stock, 0),
          )

          const copies: ProductSnapshot[] = []
          for (let i = 1; i <= n; i += 1) {
            const res = await duplicate(admin, original.id)
            expect(res.status, `duplicate ${i}: ${JSON.stringify(res.body)}`).toBe(201)
            copies.push(res.body.data!)
          }

          expect(copies.map((c) => c.slug)).toEqual(
            copies.map((_, i) => `${original.slug}${slugSuffix(i + 1)}`),
          )
          copies.forEach((copy, i) => {
            const label = `copy ${i + 1}`
            expect(copy.name, label).toBe(`${original.name} (Copy)`)
            expect(copy.status, label).toBe('draft')
            expect(copy.id, label).not.toBe(original.id)
            expect(shape(copy).variants, label).toEqual(
              before.variants
                .map((v) => ({ sku: `${v.sku}${skuSuffix(i + 1)}`, stock: 0, taxCode: v.taxCode }))
                .sort((a, b) => a.sku.localeCompare(b.sku)),
            )
          })

          for (const copy of copies) {
            const stored = await k.services.product.getById(copy.id)
            expect(
              stored.variants.map((v) => v.stock),
              `stored stock of ${copy.slug}`,
            ).toEqual(stored.variants.map(() => 0))
          }
          expect(shape(await k.services.product.getById(original.id)), 'the original').toEqual(
            before,
          )
          expect(await totalStock(k), 'total stock over every product').toBe(stockBefore)
        } finally {
          await served.stop()
        }
      }),
      { numRuns: 4 },
    )
  }, 180_000)

  describe('when the first suffix is taken', () => {
    let store: Store

    beforeAll(async () => {
      store = await openStore()
    }, 60_000)

    afterAll(async () => {
      await store?.served.stop()
    })

    it('AC-1: with <slug>-copy owned by another product (its SKUs free), the first duplicate takes <slug>-copy-2 and <sku>-COPY-2', async () => {
      const tag = randomUUID().slice(0, 8)
      const original = await seedProduct(store.k, `mug-${tag}`, `MUG-${tag}`, [
        { stock: 4, taxCode: 'standard' },
      ])
      await seedProduct(store.k, `mug-${tag}-copy`, `OTHER-${tag}`, [{ stock: 2, taxCode: null }])
      const stockBefore = await totalStock(store.k)

      const res = await duplicate(store.admin, original.id)

      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(shape(res.body.data!)).toEqual({
        slug: `${original.slug}-copy-2`,
        variants: [{ sku: `${original.variants[0]!.sku}-COPY-2`, stock: 0, taxCode: 'standard' }],
      })
      expect(await totalStock(store.k)).toBe(stockBefore)
    })

    it("AC-1: with <slug>-copy free but <sku>-COPY owned by another product's variant, the first duplicate takes <slug>-copy-2 and <sku>-COPY-2", async () => {
      const tag = randomUUID().slice(0, 8)
      const original = await seedProduct(store.k, `lamp-${tag}`, `LAMP-${tag}`, [
        { stock: 7, taxCode: null },
        { stock: 1, taxCode: 'reduced' },
      ])
      const takenSku = `${original.variants[0]!.sku}-COPY`
      await store.k.services.product.create({
        slug: `unrelated-${tag}`,
        name: `Unrelated ${tag}`,
        status: 'active',
        variants: [
          {
            sku: takenSku,
            name: 'Default',
            priceMinor: 900,
            stock: 3,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
      const stockBefore = await totalStock(store.k)

      const res = await duplicate(store.admin, original.id)

      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(shape(res.body.data!)).toEqual({
        slug: `${original.slug}-copy-2`,
        variants: shape(original)
          .variants.map((v) => ({ sku: `${v.sku}-COPY-2`, stock: 0, taxCode: v.taxCode }))
          .sort((a, b) => a.sku.localeCompare(b.sku)),
      })
      expect(await totalStock(store.k)).toBe(stockBefore)
    })
  })
})
