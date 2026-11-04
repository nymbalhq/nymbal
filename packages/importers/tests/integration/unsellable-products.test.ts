import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWooCommerceImport } from '@nymbalhq/importers'
import { buildImportEnv } from './support/import-env.js'
import {
  importedProducts,
  json,
  loadRecordedStore,
  localMedia,
  recordedFetch,
  recordedImportOptions,
  type Rec,
} from './support/recorded-store.js'

// Store A (recorded) holds a grouped product, an external product, a simple product with no price, a variable product
// none of whose variations has a price, and a free product priced "0". Here the importer also meets a variable product
// whose variations it cannot read. Needs `pnpm build`.

let dir: string | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const bySku = (products: Rec[], sku: string) => products.find((p) => p['sku'] === sku)!

describe('importing products WooCommerce would not sell as Nymbal would', () => {
  it('AC-7: a variable product whose variations cannot be read is not created, and one products error names it', async () => {
    const store = loadRecordedStore('store-a-gbp')
    const tshirt = bySku(store.products, 'TSHIRT')
    const tshirtId = tshirt['id'] as number
    dir = await mkdtemp(join(tmpdir(), 'nymbal-unreadable-variations-'))
    const env = await buildImportEnv()
    try {
      vi.stubGlobal(
        'fetch',
        recordedFetch(store, {
          override: (path) =>
            path === `/products/${tshirtId}/variations`
              ? json({ code: 'woocommerce_rest_cannot_view' }, 403)
              : undefined,
        }).fetch,
      )
      const opts = recordedImportOptions(store, dir)
      const report = await runWooCommerceImport(opts, {
        services: env.services,
        repos: env.repos,
        adapters: env.adapters,
        media: localMedia(dir),
      })

      expect(report.errors.map((e) => [e.phase, e.id])).toEqual([['products', String(tshirtId)]])
      expect(report.imported.products).toBe(store.products.length - 1)
      const state = JSON.parse(await readFile(opts.statePath, 'utf8')) as {
        wcToNymbalProduct: Record<string, string>
      }
      expect(state.wcToNymbalProduct[String(tshirtId)]).toBeUndefined()
      const all = await env.services.product.list({ limit: 1000 })
      expect(all.length).toBe(store.products.length - 1)
      expect(
        all.filter((p) => p.slug.startsWith(tshirt['slug'] as string)).map((p) => p.slug),
      ).toEqual([])
    } finally {
      await env.close()
    }
  })

  it('AC-7: grouped, external, price-less simple and price-less variable products arrive as drafts with every variant inactive, children ids and URL kept; the free product stays on sale at 0', async () => {
    const store = loadRecordedStore('store-a-gbp')
    dir = await mkdtemp(join(tmpdir(), 'nymbal-unsellable-'))
    const env = await buildImportEnv()
    try {
      vi.stubGlobal('fetch', recordedFetch(store).fetch)
      const opts = recordedImportOptions(store, dir)
      const report = await runWooCommerceImport(opts, {
        services: env.services,
        repos: env.repos,
        adapters: env.adapters,
        media: localMedia(dir),
      })
      expect(report.errors).toEqual([])
      const products = await importedProducts(env, opts.statePath)

      for (const sku of ['SET-01', 'LAMP-EXT', 'BUNDLE-01', 'WREATH']) {
        const source = bySku(store.products, sku)
        expect(source['status'], `${sku} is published in WooCommerce`).toBe('publish')
        const imported = products.get(source['id'] as number)!
        expect(imported.status, sku).toBe('draft')
        const inactive = imported.variants.filter((v) => v.status === 'inactive')
        expect(inactive.length, `${sku} variants inactive`).toBe(imported.variants.length)
      }

      const grouped = bySku(store.products, 'SET-01')
      const external = bySku(store.products, 'LAMP-EXT')
      const meta = (sku: Rec) =>
        products.get(sku['id'] as number)!.metadata['woocommerce'] as Record<string, unknown>
      expect(meta(grouped)['groupedProductIds']).toEqual(grouped['grouped_products'])
      expect(meta(external)['externalUrl']).toBe(external['external_url'])

      const free = products.get(bySku(store.products, 'STICKER-01')['id'] as number)!
      expect([free.status, free.variants.map((v) => [v.status, v.priceMinor])]).toEqual([
        'active',
        [['active', 0]],
      ])
    } finally {
      await env.close()
    }
  })
})
