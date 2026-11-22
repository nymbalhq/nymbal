import type { ProductSnapshot } from '@nymbalhq/types'

/** The product's own text, as the content role reads it: what a model may build copy from and what its claims must match. */
export interface ContentSource {
  name: string
  description: string
  shortDescription: string
  variants: Array<{ name: string; options: Array<{ name: string; value: string }> }>
  metadata: Record<string, unknown>
}

/** Countries a product may be said to come from, each beside its demonym; either one supports the other. */
export const ORIGIN_TERMS: readonly (readonly [country: string, demonym: string])[] = [
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

/**
 * Words and phrases a model's copy may hold only when the product's own text does: materials, origin, craft,
 * certifications, health and eco terms, superlatives and guarantees, and free offers. English only.
 */
export const CLAIM_TERMS: readonly string[] = [
  'organic',
  'cotton',
  'wool',
  'merino',
  'cashmere',
  'linen',
  'silk',
  'leather',
  'vegan',
  'recycled',
  'sustainable',
  'eco-friendly',
  'biodegradable',
  'handmade',
  'handcrafted',
  'hand-made',
  'hand made',
  'made in',
  'certified',
  'fairtrade',
  'hypoallergenic',
  'non-toxic',
  'bpa-free',
  'waterproof',
  'best',
  '#1',
  'award-winning',
  'guaranteed',
  'warranty',
  'free shipping',
  'free delivery',
  ...ORIGIN_TERMS.flat(),
]

/** The entities a sanitised description holds: the API writes every other character as itself. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/** An HTML fragment as plain text: tags dropped, entities decoded, whitespace collapsed. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]!)
    .replace(/\s+/g, ' ')
    .trim()
}

export function contentSourceOf(product: ProductSnapshot): ContentSource {
  return {
    name: product.name,
    description: plainText(product.description),
    shortDescription: plainText(product.shortDescription),
    variants: product.variants.map((v) => ({
      name: v.name,
      options: v.options.map((o) => ({ name: o.name, value: o.value })),
    })),
    metadata: product.metadata,
  }
}

/** Every string and number in a metadata value, nested objects and arrays included. */
function metadataValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(metadataValues)
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(metadataValues)
  return []
}

/** The source's texts as written: name, descriptions, variant names and option values, metadata values. */
export function sourceParts(source: ContentSource): string[] {
  return [
    source.name,
    source.description,
    source.shortDescription,
    ...source.variants.flatMap((v) => [v.name, ...v.options.map((o) => o.value)]),
    ...metadataValues(source.metadata),
  ].filter((part) => part !== '')
}

/** The source as one lowercased text, whitespace collapsed; parts are kept apart so no phrase spans two. */
export function sourceText(source: ContentSource): string {
  return sourceParts(source).join(' | ').toLowerCase().replace(/\s+/g, ' ')
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `term` in `text` as a whole word or phrase: no letter or digit right before or after it. */
export function holdsWhole(text: string, term: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'u').test(text)
}

/** A number as written: digits, a decimal part, and a `%` or unit letters right after it. Not `#1`, a lexicon term. */
const NUMBER = /(?<![#\p{L}\p{N}])\d+(?:[.,]\d+)*(?:%|\p{L}+)?/gu

/** A number held in `text`: not inside a longer number or word. */
function holdsNumber(text: string, number: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(number)}(?![\\p{L}\\p{N}]|[.,]\\d)`, 'u').test(
    text,
  )
}

const supporting = new Map<string, readonly string[]>(
  ORIGIN_TERMS.flatMap(([country, demonym]) => [
    [country, [country, demonym]],
    [demonym, [country, demonym]],
  ]),
)

/**
 * The lexicon terms and numbers in `copy` that the source does not state, in the copy's order. An origin term is
 * supported by either member of its pair. Only the copy is checked, never the merchant's text.
 */
export function claimGuard(copy: string, source: ContentSource): { unsupported: string[] } {
  const text = copy.toLowerCase().replace(/\s+/g, ' ')
  const held = sourceText(source)
  const unsupported: Array<{ at: number; term: string }> = []
  for (const term of CLAIM_TERMS) {
    if (!holdsWhole(text, term)) continue
    if ((supporting.get(term) ?? [term]).some((t) => holdsWhole(held, t))) continue
    unsupported.push({
      at: text.search(new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}`, 'u')),
      term,
    })
  }
  for (const match of text.matchAll(NUMBER)) {
    if (!holdsNumber(held, match[0]) && !unsupported.some((u) => u.term === match[0])) {
      unsupported.push({ at: match.index, term: match[0] })
    }
  }
  return { unsupported: unsupported.sort((a, b) => a.at - b.at).map((u) => u.term) }
}
