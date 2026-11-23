import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import { validateUcp } from '../../../../tests/fixtures/ucp/validate.js'
import { acpClient, acpStore, PRODUCTS_RESPONSE, untilListed } from '../support/acp.js'
import { agentCaller, type AgentStore } from '../support/agents.js'

// A product's brand and its variant's GTIN in the agent feeds, served as `nymbal dev` serves them (SQLite, ACP on):
// the UCP product feed and get_product carry the brand as metadata and the GTIN as the variant's barcode; the ACP feed
// carries the barcode and no brand (its product schema refuses unknown keys). A product with neither has neither key.

const GTIN = '4006381333931'
const FEED_PATH = '/agents/products.json'

type Json = Record<string, unknown>

let store: AgentStore
let identified: { slug: string; variantId: string }
let plain: { slug: string; variantId: string }

beforeAll(async () => {
  store = await acpStore()
  const tag = randomUUID().slice(0, 8)
  const make = async (slug: string, extra: { brand?: string; gtin?: string }) => {
    const created = await store.kernel.services.product.create({
      slug,
      name: `Desk Lamp ${slug}`,
      description: 'A lamp for the desk.',
      status: 'active',
      ...(extra.brand !== undefined && { brand: extra.brand }),
      variants: [
        {
          sku: `LAMP-${slug}`,
          name: 'Brass',
          priceMinor: 4_500,
          stock: 6,
          options: [],
          ...(extra.gtin !== undefined && { gtin: extra.gtin }),
        },
      ],
    })
    return { slug, variantId: created.variants[0]!.id }
  }
  identified = await make(`lamp-id-${tag}`, { brand: 'Acme Lighting', gtin: GTIN })
  plain = await make(`lamp-plain-${tag}`, {})
  await untilListed(store.baseUrl, [identified.slug, plain.slug])
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

/** Every page of the UCP product feed, walked by its cursor. */
async function feedPages(): Promise<Array<{ products: Json[] }>> {
  const pages: Array<{ products: Json[] }> = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const res = await fetch(
      new URL(
        `${FEED_PATH}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
        store.baseUrl,
      ),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      products: Json[]
      pagination?: { has_next_page: boolean; cursor?: string }
    }
    pages.push(body)
    if (body.pagination?.has_next_page !== true) break
    cursor = body.pagination.cursor
  }
  return pages
}

/** What a feed says of a product's identifiers: its metadata, and each variant's barcodes, keys absent as absent. */
function identifiersOf(product: Json | undefined) {
  const variants = (product?.['variants'] ?? []) as Json[]
  return {
    metadata: product !== undefined && 'metadata' in product ? product['metadata'] : 'absent',
    barcodes: variants.map((v) => ('barcodes' in v ? v['barcodes'] : 'absent')),
  }
}

const FIRST = { metadata: { brand: 'Acme Lighting' }, barcodes: [[{ type: 'GTIN', value: GTIN }]] }
const SECOND = { metadata: 'absent', barcodes: ['absent'] }

describe('brand and GTIN in the agent feeds', () => {
  it('AC-7: /agents/products.json lists the product with a brand and a GTIN with metadata.brand and its variant’s barcodes, the product with neither with neither key, and every page validates as a UCP catalogue search response', async () => {
    const pages = await feedPages()
    const products = pages.flatMap((p) => p.products)

    expect(
      pages.map((page) => validateUcp('shopping/catalog_search.json#/$defs/search_response', page)),
    ).toEqual(pages.map(() => []))
    expect(identifiersOf(products.find((p) => p['id'] === identified.slug))).toEqual(FIRST)
    expect(identifiersOf(products.find((p) => p['id'] === plain.slug))).toEqual(SECOND)
  })

  it('AC-7: UCP get_product answers the same two shapes, each a valid get_product response', async () => {
    const answers = await Promise.all(
      [identified.slug, plain.slug].map((id) =>
        store.ucp.call('get_product', { catalog: { id } }, agentCaller('feed-identifiers-bot')),
      ),
    )
    const payloads = answers.map((a) => (a.structuredContent ?? {}) as Json)

    expect(answers.map((a) => a.isError ?? false)).toEqual([false, false])
    expect(
      payloads.map((p) =>
        validateUcp('shopping/catalog_lookup.json#/$defs/get_product_response', p),
      ),
    ).toEqual([[], []])
    expect(payloads.map((p) => identifiersOf(p['product'] as Json))).toEqual([FIRST, SECOND])
  })

  it('AC-7: GET /api/acp/feed lists the product with a GTIN with its variant’s barcodes and no brand key anywhere in the product, the product with neither with no barcodes, and validates as ProductsResponse', async () => {
    const feed = await acpClient(store.baseUrl).feed()
    expect(feed.status, JSON.stringify(feed.body).slice(0, 500)).toBe(200)
    const products = feed.body.products as unknown as Json[]
    const first = products.find((p) => p['id'] === identified.slug)
    const second = products.find((p) => p['id'] === plain.slug)

    expect(validateAcp(PRODUCTS_RESPONSE, feed.body)).toEqual([])
    expect(identifiersOf(first).barcodes).toEqual(FIRST.barcodes)
    expect(identifiersOf(second).barcodes).toEqual(SECOND.barcodes)
    expect(
      [first, second].map((p) => [
        p?.['id'],
        JSON.stringify(p ?? null).includes('Acme Lighting'),
        'metadata' in (p ?? {}),
      ]),
    ).toEqual([
      [identified.slug, false, false],
      [plain.slug, false, false],
    ])
  })
})
