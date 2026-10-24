import { performance } from 'node:perf_hooks'
import type { SearchAdapter, SearchDocument } from '@nymbalhq/types'
import { matchesQuery, type ContractProduct } from '../../../contract-tests/src/index.js'

// A 10k-product catalogue with realistic names, descriptions, SKUs and 20 categories, the same on every run (a seeded
// generator), and the 50 queries the search benchmark times: one and two terms, prefixes, hits and misses.

/** mulberry32: a small seeded generator, so the catalogue is the same on every run and dialect. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ADJECTIVES = [
  'classic',
  'merino',
  'organic',
  'vintage',
  'slim',
  'relaxed',
  'heavyweight',
  'lightweight',
  'waterproof',
  'quilted',
  'ribbed',
  'striped',
  'brushed',
  'recycled',
  'everyday',
  'tailored',
  'cropped',
  'oversized',
  'essential',
  'heritage',
  'alpine',
  'coastal',
  'urban',
  'field',
  'studio',
  'weekend',
  'travel',
  'signature',
  'premium',
  'soft',
]
const MATERIALS = [
  'wool',
  'cotton',
  'linen',
  'cashmere',
  'denim',
  'leather',
  'suede',
  'silk',
  'canvas',
  'fleece',
  'corduroy',
  'twill',
  'jersey',
  'nylon',
  'hemp',
  'bamboo',
  'tweed',
  'flannel',
  'poplin',
  'chambray',
]
const GARMENTS = [
  'crew',
  'sweater',
  'cardigan',
  'hoodie',
  'jacket',
  'parka',
  'coat',
  'shirt',
  'tee',
  'polo',
  'chino',
  'trouser',
  'shorts',
  'skirt',
  'dress',
  'scarf',
  'beanie',
  'gloves',
  'socks',
  'boots',
  'sneaker',
  'loafer',
  'belt',
  'bag',
  'backpack',
  'tote',
  'wallet',
  'cap',
  'vest',
  'blazer',
]
const COLOURS = [
  'navy',
  'black',
  'white',
  'grey',
  'olive',
  'rust',
  'cream',
  'charcoal',
  'sand',
  'forest',
]
const SIZES = ['XS', 'S', 'M', 'L', 'XL']
const PROSE = [
  'made',
  'from',
  'with',
  'a',
  'the',
  'and',
  'for',
  'every',
  'day',
  'soft',
  'hand',
  'feel',
  'cut',
  'fit',
  'easy',
  'layer',
  'over',
  'under',
  'season',
  'after',
  'season',
  'garment',
  'dyed',
  'washed',
  'finish',
  'durable',
  'stitched',
  'seams',
  'ribbed',
  'cuffs',
  'hem',
  'collar',
  'pocket',
  'pockets',
  'zip',
  'button',
  'front',
  'back',
  'yoke',
  'breathable',
  'warm',
  'cool',
  'weather',
  'rain',
  'wind',
  'city',
  'trail',
  'office',
  'travel',
  'packable',
  'machine',
  'wash',
  'cold',
  'tumble',
  'dry',
  'low',
  'responsibly',
  'sourced',
  'mill',
  'portugal',
  'italy',
  'japan',
  'scotland',
  'woven',
  'knitted',
  'loom',
  'yarn',
  'gauge',
  'brushed',
  'interior',
  'lining',
  'shell',
  'trim',
  'detail',
  'contrast',
  'tonal',
  'logo',
  'embroidered',
  'heavy',
  'light',
  'midweight',
  'structured',
  'drape',
  'relaxed',
  'regular',
  'boxy',
  'tapered',
  'straight',
  'leg',
  'sleeve',
  'long',
  'short',
  'raglan',
  'set',
  'in',
  'shoulder',
  'neck',
  'v',
  'round',
  'mock',
  'roll',
  'hood',
  'drawcord',
  'adjustable',
  'elastic',
  'waist',
  'belt',
  'loops',
  'reinforced',
  'knees',
  'elbows',
  'patches',
  'suede',
  'leather',
  'horn',
  'buttons',
  'metal',
  'hardware',
]

export const CATEGORY_COUNT = 20

export interface SearchCatalogue {
  categories: string[]
  products: ContractProduct[]
  documents: SearchDocument[]
  queries: Array<{ query: string; hit: boolean }>
}

const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

export function searchCatalogue(size = 10_000): SearchCatalogue {
  const rand = seeded(0x5ea2c4)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const categories = Array.from(
    { length: CATEGORY_COUNT },
    (_, k) => `cat-${String(k).padStart(2, '0')}-${pick(GARMENTS)}`,
  )
  const products: ContractProduct[] = []
  for (let i = 0; i < size; i++) {
    const adjective = pick(ADJECTIVES)
    const material = pick(MATERIALS)
    const garment = pick(GARMENTS)
    const words = Array.from({ length: 20 + Math.floor(rand() * 21) }, () =>
      rand() < 0.1 ? pick([...MATERIALS, ...GARMENTS]) : pick(PROSE),
    )
    const colours = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(COLOURS))
    const code =
      `${adjective.slice(0, 2)}${material.slice(0, 2)}${garment.slice(0, 2)}`.toUpperCase()
    products.push({
      id: `search-bench-${String(i).padStart(5, '0')}`,
      name: `${title(adjective)} ${title(material)} ${title(garment)}`,
      description: `${title(words.join(' '))}.`,
      variants: colours.map((colour, v) => {
        const size = pick(SIZES)
        return {
          sku: `${code}-${String(i).padStart(5, '0')}-${v}${size}`,
          name: `${title(colour)} / ${size}`,
          priceMinor: 1500 + Math.floor(rand() * 30_000),
        }
      }),
      categoryIds: [categories[i % CATEGORY_COUNT]!],
    })
  }
  const documents = products.map((p) => ({
    id: p.id,
    type: 'product',
    fields: {
      slug: p.id,
      name: p.name,
      description: p.description,
      status: 'active',
      categoryIds: p.categoryIds,
      variants: p.variants,
    },
  }))

  const oneTerm = [
    'wool',
    'cashmere',
    'jacket',
    'sweater',
    'denim',
    'leather',
    'boots',
    'navy',
    'linen',
    'hoodie',
    'woo',
    'jack',
    'cash',
    'swe',
    'merino',
    'waterproof',
    'portugal',
    'raglan',
    'tote',
    'olive',
  ]
  const twoTerm = Array.from({ length: 15 }, (_, k) => {
    const p = products[(k * 613) % products.length]!
    const [, material, garment] = p.name.toLowerCase().split(' ')
    return `${material} ${garment}`
  })
  const misses = [
    'zqxj',
    'xylograph',
    'qwvz',
    'jjjq',
    'vvxk',
    'wool zqxj',
    'zqxj jacket',
    'denim xylograph',
    'qqqq tote',
    'kxvz',
    'zzzzz',
    'cashmere qwvz',
    'mmqz',
    'xqj',
    'vzx navy',
  ]
  const queries = [
    ...oneTerm.map((query) => ({ query, hit: true })),
    ...twoTerm.map((query) => ({ query, hit: true })),
    ...misses.map((query) => ({ query, hit: false })),
  ]
  return { categories, products, documents, queries }
}

/** Indexes the catalogue one product per call, as a warm start's replay of product.created does; returns the ms. */
export async function indexOneByOne(
  adapter: SearchAdapter,
  documents: SearchDocument[],
): Promise<number> {
  const started = performance.now()
  for (const doc of documents) await adapter.index([doc])
  return performance.now() - started
}

export interface QueryTiming {
  query: string
  ms: number
  total: number
  expected: number
  facetValues: number
}

/** The 50 queries, each `search({limit: 20})` and its category facet, once to warm, then timed. */
export async function timeQueries(
  adapter: SearchAdapter,
  catalogue: SearchCatalogue,
): Promise<QueryTiming[]> {
  const run = async ({ query }: { query: string }) => {
    const started = performance.now()
    const result = await adapter.search(query, { limit: 20 })
    const facet = await adapter.facet('categoryIds', { query })
    return {
      ms: performance.now() - started,
      total: result.total,
      facetValues: facet.values.length,
    }
  }
  for (const q of catalogue.queries) await run(q)
  const timings: QueryTiming[] = []
  for (const q of catalogue.queries) {
    const timed = await run(q)
    timings.push({
      query: q.query,
      ...timed,
      expected: catalogue.products.filter((p) => matchesQuery(p, q.query)).length,
    })
  }
  return timings
}

/** The nearest-rank percentile of the timings, in ms. */
export function percentile(timings: QueryTiming[], p: number): number {
  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!
}
