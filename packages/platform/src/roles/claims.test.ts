import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ProductSnapshot } from '@nymbalhq/types'
import {
  CLAIM_TERMS as CLAIM_TERMS_EXPORT,
  ORIGIN_TERMS as ORIGIN_TERMS_EXPORT,
  claimGuard,
  contentSourceOf,
  type ContentSource,
} from './claims.js'

// The claim guard: every lexicon term and number in a model's copy must be something the product's own text states
// (name, descriptions, variant names and option values, metadata values). No oracle: copy is built from neutral words
// and what a generated source holds, then given exactly one term or number the source lacks.

const CLAIM_TERMS: readonly string[] = CLAIM_TERMS_EXPORT
const ORIGIN_TERMS: ReadonlyArray<readonly [string, string]> = ORIGIN_TERMS_EXPORT

const NEUTRAL = [
  'roomy',
  'sturdy',
  'simple',
  'daily',
  'pocket',
  'strap',
  'zipped',
  'handle',
  'shape',
  'light',
  'soft',
  'clean',
  'tidy',
  'travel',
  'weekend',
  'commute',
  'carry',
  'fold',
  'pack',
  'neat',
  'calm',
  'steady',
  'gentle',
  'bright',
  'quiet',
  'plain',
  'easy',
  'smooth',
  'broad',
  'compact',
  'spare',
  'sleek',
  'useful',
  'handy',
  'sized',
  'padded',
]

const neutral = (): string[] => NEUTRAL.filter((w) => !CLAIM_TERMS.includes(w))

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase())

/** The single-word lexicon entries: inserting one adds exactly one term, never a phrase or a number with it. */
const singleWords = (): string[] => CLAIM_TERMS.filter((t) => /^[a-z]+$/.test(t))

/** Every term `term` supports, its origin pair included. */
function supportedBy(term: string): string[] {
  const pair = ORIGIN_TERMS.find(([country, demonym]) => country === term || demonym === term)
  return pair === undefined ? [term] : [...pair]
}

/** Keys and option names without digits, so the only numbers in a source are the facts it holds. */
const LETTERS = 'abcdefgh'

type Spot = 'description' | 'shortDescription' | 'metadata' | 'nested' | 'option' | 'variant'
const SPOTS: readonly Spot[] = [
  'description',
  'shortDescription',
  'metadata',
  'nested',
  'option',
  'variant',
]

/** A source holding each fact at its spot, among neutral words. */
function sourceHolding(facts: ReadonlyArray<{ text: string | number; spot: Spot }>): ContentSource {
  const source: ContentSource = {
    name: 'Qalder Tote',
    description: 'A plain tote.',
    shortDescription: '',
    variants: [{ name: 'Default', options: [] }],
    metadata: {},
  }
  facts.forEach(({ text, spot }, i) => {
    switch (spot) {
      case 'description':
        source.description += ` It is ${text} inside.`
        break
      case 'shortDescription':
        source.shortDescription += ` Has ${text} on it.`
        break
      case 'metadata':
        source.metadata[`fact${LETTERS[i]}`] = text
        break
      case 'nested':
        source.metadata[`group${LETTERS[i]}`] = { detail: text }
        break
      case 'option':
        source.variants[0]!.options.push({ name: `Option ${LETTERS[i]}`, value: String(text) })
        break
      case 'variant':
        source.variants.push({ name: `Style ${text}`, options: [] })
        break
    }
  })
  return source
}

interface Case {
  source: ContentSource
  copy: string
  terms: string[]
  numbers: number[]
}

const supported: fc.Arbitrary<Case> = fc
  .record({
    terms: fc.uniqueArray(fc.constantFrom(...singleWords()), { maxLength: 3 }),
    numbers: fc.uniqueArray(fc.integer({ min: 2, max: 999 }), { maxLength: 2 }),
    spots: fc.array(fc.constantFrom(...SPOTS), { minLength: 5, maxLength: 5 }),
    words: fc.shuffledSubarray(neutral(), { minLength: 4, maxLength: 8 }),
    seed: fc.nat(),
  })
  .map(({ terms, numbers, spots, words, seed }) => {
    const facts = [...terms, ...numbers].map((text, i) => ({ text, spot: spots[i]! }))
    const parts = [...words, ...terms, ...numbers.map(String)]
    const shuffled = parts
      .map((p, i) => ({ p, k: (i * 7919 + seed) % 104_729 }))
      .sort((a, b) => a.k - b.k)
    return {
      source: sourceHolding(facts),
      copy: shuffled.map((x) => x.p).join(' '),
      terms,
      numbers,
    }
  })

function snapshotOf(over: Partial<ProductSnapshot>): ProductSnapshot {
  return {
    id: 'p1',
    slug: 'p1',
    name: 'Qalder Tote',
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'simple',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    variants: [],
    categoryIds: [],
    ...over,
  }
}

describe('AC-3: claimGuard, the claim lexicon against the product’s own text', () => {
  it('AC-3: the lexicon holds the terms the rules name, every origin pair, and each pair supports the other', () => {
    const named = [
      'organic',
      'cotton',
      'wool',
      'merino',
      'silk',
      'leather',
      'vegan',
      'recycled',
      'handmade',
      'handcrafted',
      'hand-made',
      'hand made',
      'made in',
      'certified',
      'fairtrade',
      'hypoallergenic',
      'bpa-free',
      'waterproof',
      'best',
      '#1',
      'award-winning',
      'guaranteed',
      'free shipping',
      'free delivery',
    ]
    const pairs = [
      ['italy', 'italian'],
      ['portugal', 'portuguese'],
      ['france', 'french'],
      ['japan', 'japanese'],
      ['china', 'chinese'],
      ['germany', 'german'],
      ['spain', 'spanish'],
      ['india', 'indian'],
      ['turkey', 'turkish'],
      ['peru', 'peruvian'],
      ['scotland', 'scottish'],
      ['england', 'english'],
      ['ireland', 'irish'],
      ['usa', 'american'],
      ['mexico', 'mexican'],
    ]

    expect(named.filter((t) => !CLAIM_TERMS.includes(t))).toEqual([])
    expect(
      pairs.filter(([c, d]) => !ORIGIN_TERMS.some(([oc, od]) => oc === c && od === d)),
    ).toEqual([])
    expect(ORIGIN_TERMS.flat().filter((t) => !CLAIM_TERMS.includes(t))).toEqual([])
    const crossed = ORIGIN_TERMS.map(([country, demonym]) => [
      claimGuard(`Made of ${demonym} cloth`, sourceHolding([{ text: country, spot: 'metadata' }]))
        .unsupported,
      claimGuard(`From ${country} itself`, sourceHolding([{ text: demonym, spot: 'description' }]))
        .unsupported,
    ])
    expect(crossed).toEqual(ORIGIN_TERMS.map(() => [[], []]))
  })

  it('AC-3: property: copy of neutral words plus lexicon terms and numbers the source holds, wherever it holds them, is supported', () => {
    fc.assert(
      fc.property(supported, (c) => {
        expect(claimGuard(c.copy, c.source).unsupported).toEqual([])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: property: the same copy with one lexicon term the source lacks inserted reports exactly that term', () => {
    fc.assert(
      fc.property(supported, fc.nat(), (c, i) => {
        const held = new Set(c.terms.flatMap(supportedBy))
        const lacking = singleWords().filter((t) => !held.has(t))
        const term = lacking[i % lacking.length]!
        expect(lower(claimGuard(`${c.copy} ${term}`, c.source).unsupported)).toEqual([term])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: property: the same copy with one number the source lacks inserted reports exactly that number', () => {
    fc.assert(
      fc.property(supported, fc.integer({ min: 1, max: 9999 }), (c, n) => {
        fc.pre(!c.numbers.includes(n))
        expect(claimGuard(`${c.copy} ${n}`, c.source).unsupported).toEqual([String(n)])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: organic against 100% cotton, Italian against a source with no Italy, and handcrafted against handmade are unsupported; Portuguese against origin Portugal, merino against merino wool and 100% against 100% cotton are supported; best inside bestseller is no match', () => {
    const cotton = contentSourceOf(snapshotOf({ description: '<p>Made from 100% cotton.</p>' }))
    const woolly = contentSourceOf(
      snapshotOf({
        metadata: { material: 'merino wool', origin: 'Portugal' },
        description: 'A warm scarf.',
      }),
    )
    const handmade = contentSourceOf(snapshotOf({ description: 'A handmade bowl.' }))
    const plain = contentSourceOf(snapshotOf({ description: 'A full-grain leather bag.' }))

    expect(
      [
        claimGuard('Organic cotton tee', cotton),
        claimGuard('Italian leather bag', plain),
        claimGuard('A handcrafted bowl', handmade),
        claimGuard('Portuguese merino scarf', woolly),
        claimGuard('100% cotton tee', cotton),
        claimGuard('Our bestseller tote', plain),
      ].map((r) => lower(r.unsupported)),
    ).toEqual([['organic'], ['italian'], ['handcrafted'], [], [], []])
  })

  it('AC-3: a fact held only in a variant option or a variant name supports the claim; the same claim against a source without that variant does not', () => {
    const withVariant = contentSourceOf(
      snapshotOf({
        variants: [
          {
            id: 'v1',
            productId: 'p1',
            sku: 'S1',
            name: 'Silk edition',
            priceMinor: 1000,
            compareAtPriceMinor: null,
            weightGrams: null,
            dimensions: null,
            stock: 1,
            lowStockThreshold: 0,
            options: [{ name: 'Fabric', value: 'Recycled' }],
            status: 'active',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      }),
    )
    const without = contentSourceOf(snapshotOf({}))

    expect([
      lower(claimGuard('A recycled silk tote', withVariant).unsupported),
      lower(claimGuard('A recycled silk tote', without).unsupported).sort(),
    ]).toEqual([[], ['recycled', 'silk']])
  })
})
