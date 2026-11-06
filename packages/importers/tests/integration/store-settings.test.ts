import { mkdtemp, rm } from 'node:fs/promises'
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
  minorUnits,
  recordedFetch,
  recordedImportOptions,
  type Rec,
  type RecordedFetchOptions,
  type RecordedStoreName,
} from './support/recorded-store.js'

// The import reads the WooCommerce store's currency, units and low-stock amount from its settings
// (/settings/general, /settings/products) before it writes. A currency that is not the Nymbal store's refuses the
// import; settings it cannot read fall back to the Nymbal store's currency, kg, cm and a low-stock amount of 2, with
// a warning. Needs `pnpm build`.

let dir: string | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function importRecorded(
  name: RecordedStoreName,
  fetchOpts: RecordedFetchOptions,
  overrides: Parameters<typeof recordedImportOptions>[2] = {},
) {
  const store = loadRecordedStore(name)
  dir = await mkdtemp(join(tmpdir(), `nymbal-settings-${name}-`))
  const env = await buildImportEnv()
  const mock = recordedFetch(store, fetchOpts)
  vi.stubGlobal('fetch', mock.fetch)
  const opts = recordedImportOptions(store, dir, overrides)
  const run = runWooCommerceImport(opts, {
    services: env.services,
    repos: env.repos,
    adapters: env.adapters,
    media: localMedia(dir),
  })
  // Handled here so a refusal before the test awaits it is not reported as unhandled; the test still reads it.
  run.catch(() => undefined)
  return { store, env, mock, opts, run }
}

const refused = (status: number) => () =>
  json(
    { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' },
    status,
  )

describe('a WooCommerce store in another currency', () => {
  for (const [name, nymbalCurrency] of [
    ['store-b-jpy', 'GBP'],
    ['store-a-gbp', 'EUR'],
  ] as const) {
    it(`AC-5: ${name} into a ${nymbalCurrency} store is refused before any write, naming both currencies`, async () => {
      const { store, env, run } = await importRecorded(name, {}, { currency: nymbalCurrency })
      try {
        const error = await run.then(
          () => null,
          (e: unknown) => e,
        )
        expect(error, 'the import was refused').toBeInstanceOf(Error)
        expect((error as Error).message).toContain(store.currency)
        expect((error as Error).message).toContain(nymbalCurrency)
        expect(await env.services.product.list({ limit: 1000 })).toEqual([])
        expect(await env.services.category.list()).toEqual([])
      } finally {
        await env.close()
      }
    })
  }

  it('AC-5: a Nymbal store whose currency is written in lower case imports a store in the same currency', async () => {
    const { store, env, opts, run } = await importRecorded('store-a-gbp', {}, { currency: 'gbp' })
    try {
      const report = await run
      expect(report.errors).toEqual([])
      expect(report.imported.products).toBe(store.products.length)
      const products = await importedProducts(env, opts.statePath)
      const tote = store.products.find((p) => p['sku'] === 'TOTE-01')!
      expect(products.get(tote['id'] as number)!.variants[0]!.priceMinor).toBe(
        minorUnits(tote['price'] as string, 'GBP'),
      )
    } finally {
      await env.close()
    }
  })
})

describe('WooCommerce settings the import cannot read', () => {
  const weightOf = (p: Rec) => p['weight'] as string
  const dimensionsOf = (p: Rec) =>
    p['dimensions'] as { length: string; width: string; height: string }
  const decimalTimes = (value: string, factor: number) => Math.round(Number(value) * factor)

  it('AC-5: a 401 on both settings answers imports in the Nymbal store’s currency, kg, cm and a low-stock amount of 2, with one settings warning and no error', async () => {
    const { store, env, opts, run } = await importRecorded('store-a-gbp', {
      override: (path) => (path.startsWith('/settings') ? refused(401)() : undefined),
    })
    try {
      const report = await run
      expect(report.errors).toEqual([])
      expect(report.warnings.filter((w) => w.phase === 'settings')).toHaveLength(1)
      expect(report.imported.products).toBe(store.products.length)
      const products = await importedProducts(env, opts.statePath)
      // Store A's own low-stock amount is 3; with its settings unread, products with none of their own take 2.
      const napkins = store.products.find((p) => p['sku'] === 'NAPKIN-04')!
      expect(napkins['low_stock_amount']).toBeNull()
      const variant = products.get(napkins['id'] as number)!.variants[0]!
      expect(variant.lowStockThreshold).toBe(2)
      expect(variant.priceMinor).toBe(minorUnits(napkins['price'] as string, opts.currency))
    } finally {
      await env.close()
    }
  })

  it('AC-5: a 403 on /settings/products alone is unreadable settings too: a store in lbs and in imports its weights as kg and sizes as cm, with one settings warning and no error', async () => {
    const { store, env, opts, run } = await importRecorded('store-b-jpy', {
      override: (path) => (path === '/settings/products' ? refused(403)() : undefined),
    })
    try {
      const report = await run
      expect(report.errors).toEqual([])
      expect(report.warnings.filter((w) => w.phase === 'settings')).toHaveLength(1)
      const products = await importedProducts(env, opts.statePath)
      const matcha = store.products.find((p) => p['sku'] === 'MATCHA-C30')!
      const variant = products.get(matcha['id'] as number)!.variants[0]!
      expect(variant.weightGrams).toBe(decimalTimes(weightOf(matcha), 1000))
      const d = dimensionsOf(matcha)
      expect(variant.dimensions).toEqual({
        lengthMm: decimalTimes(d.length, 10),
        widthMm: decimalTimes(d.width, 10),
        heightMm: decimalTimes(d.height, 10),
      })
      expect(variant.priceMinor).toBe(minorUnits(matcha['price'] as string, opts.currency))
    } finally {
      await env.close()
    }
  })

  it('AC-5: with its settings read, the same store imports in lbs and in, and with no settings warning', async () => {
    const { store, env, opts, run } = await importRecorded('store-b-jpy', {})
    try {
      const report = await run
      expect(report.warnings.filter((w) => w.phase === 'settings')).toEqual([])
      const products = await importedProducts(env, opts.statePath)
      const matcha = store.products.find((p) => p['sku'] === 'MATCHA-C30')!
      const variant = products.get(matcha['id'] as number)!.variants[0]!
      expect(variant.weightGrams).toBe(decimalTimes(weightOf(matcha), 453.59237))
      expect(variant.dimensions!.heightMm).toBe(decimalTimes(dimensionsOf(matcha).height, 25.4))
    } finally {
      await env.close()
    }
  })
})

describe('the untracked-stock option', () => {
  it('AC-3: untracked products in stock import at the untrackedStock the import is given', async () => {
    const { store, env, opts, run } = await importRecorded('store-a-gbp', {}, { untrackedStock: 7 })
    try {
      await run
      const products = await importedProducts(env, opts.statePath)
      const untracked = store.products.filter(
        (p) =>
          p['type'] === 'simple' &&
          p['manage_stock'] === false &&
          p['stock_status'] === 'instock' &&
          p['price'] !== '',
      )
      expect(untracked.length).toBeGreaterThanOrEqual(2)
      for (const p of untracked) {
        expect(products.get(p['id'] as number)!.variants[0]!.stock, p['sku'] as string).toBe(
          opts.untrackedStock,
        )
      }
    } finally {
      await env.close()
    }
  })

  for (const untrackedStock of [-1, 2.5]) {
    it(`AC-3: an untrackedStock of ${untrackedStock} is refused before any request`, async () => {
      const { env, mock, run } = await importRecorded('store-a-gbp', {}, { untrackedStock })
      try {
        const error = await run.then(
          () => null,
          (e: unknown) => e,
        )
        expect(error, 'the import was refused').toBeInstanceOf(Error)
        expect(mock.requests).toEqual([])
      } finally {
        await env.close()
      }
    })
  }
})
