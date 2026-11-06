import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiAdapter } from '@nymbalhq/types'
import { runWooCommerceImport } from '@nymbalhq/importers'
import { buildImportEnv } from './support/import-env.js'
import {
  importedProducts,
  loadRecordedStore,
  localMedia,
  recordedFetch,
  recordedImportOptions,
  type ImportedProduct,
  type RecordedStore,
} from './support/recorded-store.js'

// AI enrichment rewrites a product's copy after the import created it. What the mapper kept in
// metadata.woocommerce (ids, classes, tags, attributes, custom fields) must outlive that rewrite. Store A (recorded) is
// imported twice, once without enrichment and once with an AI adapter that enriches every product, and each product's
// metadata compared between the two. Needs `pnpm build`.

const ENRICHED = JSON.stringify({
  description: 'Rewritten by the assistant.',
  shortDescription: 'Rewritten.',
  seoTitle: 'Rewritten title',
  seoDescription: 'Rewritten description.',
})

const enrichingAi: AiAdapter = {
  kind: 'ai',
  providerName: 'fake',
  capabilities: () => ['complete'],
  producesEvents: [],
  consumesEvents: [],
  initialize: async () => undefined,
  healthCheck: async () => ({ status: 'healthy' }),
  embed: async (texts) => texts.map(() => [0]),
  complete: async () => ENRICHED,
  chat: async () => ({
    text: ENRICHED,
    stopReason: 'end',
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'fake',
    toolCalls: [],
  }),
}

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function importStore(store: RecordedStore, ai: boolean) {
  const dir = await mkdtemp(join(tmpdir(), `nymbal-enrich-${ai ? 'on' : 'off'}-`))
  dirs.push(dir)
  const env = await buildImportEnv()
  try {
    vi.stubGlobal('fetch', recordedFetch(store).fetch)
    const opts = recordedImportOptions(store, dir, { ai })
    const report = await runWooCommerceImport(opts, {
      services: env.services,
      repos: env.repos,
      adapters: { ...env.adapters, ai: ai ? enrichingAi : null },
      media: localMedia(dir),
    })
    return { report, products: await importedProducts(env, opts.statePath) }
  } finally {
    await env.close()
  }
}

const woo = (p: ImportedProduct) => p.metadata['woocommerce'] as Record<string, unknown>
const without = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

describe('AI enrichment and the imported metadata', () => {
  it('AC-8: after enrichment each product keeps every metadata.woocommerce key the mapper wrote, with enriched and enrichedAt beside them, and the pre-enrichment description under metadata.original', async () => {
    const store = loadRecordedStore('store-a-gbp')
    const plain = await importStore(store, false)
    const enriched = await importStore(store, true)

    expect(enriched.report.enriched.enriched).toBe(enriched.report.imported.products)
    expect([...enriched.products.keys()].sort()).toEqual([...plain.products.keys()].sort())
    for (const [wcId, product] of enriched.products) {
      const before = plain.products.get(wcId)!
      const after = woo(product)
      expect(without(after, ['enriched', 'enrichedAt', 'syncedAt']), `product ${wcId}`).toEqual(
        without(woo(before), ['syncedAt']),
      )
      expect(after['id'], `product ${wcId}`).toBe(wcId)
      expect(after['enriched'], `product ${wcId}`).toBe(true)
      expect(Date.parse(after['enrichedAt'] as string), `product ${wcId}`).toBeGreaterThanOrEqual(
        Date.parse(after['syncedAt'] as string),
      )
      const original = product.metadata['original'] as { description?: unknown } | undefined
      expect(original?.description, `product ${wcId}`).toBe(before.description)
      expect(product.description, `product ${wcId}`).not.toBe(before.description)
    }
  })

  it('AC-8: public custom fields arrive under metadata.woocommerce.meta, a repeated key as its values in order, and "_" keys do not', async () => {
    const store = loadRecordedStore('store-a-gbp')
    const { products } = await importStore(store, true)
    for (const wc of store.products) {
      const entries = wc['meta_data'] as Array<{ key: string; value: unknown }>
      const expected: Record<string, unknown> = {}
      for (const key of new Set(entries.map((e) => e.key))) {
        if (key.startsWith('_')) continue
        const values = entries.filter((e) => e.key === key).map((e) => e.value)
        expected[key] = values.length === 1 ? values[0] : values
      }
      const meta = woo(products.get(wc['id'] as number)!)['meta']
      expect(meta, `product ${wc['id'] as number}`).toEqual(expected)
    }
  })
})
