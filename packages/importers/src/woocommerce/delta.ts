import { createHash } from 'node:crypto'
import {
  sanitizeDescription,
  type ProductService,
  type VariantPriceInput,
} from '@nymbalhq/platform'
import type { MediaStorage, ProductSnapshot } from '@nymbalhq/types'
import { ENTITIES } from '../state.js'
import type { ImportEntity, ImportState, ImportWarning, SinceByEntity } from '../types.js'
import type { WcProduct, WcVariation } from './client.js'
import { mapProduct, productSlug } from './mappers/product.js'
import { downloadProductImages, type ImagePolicy } from './media.js'
import { imageSources } from './refs.js'

export type ImportSinceReason =
  | 'invalid'
  | 'no-state'
  | 'no-finished-run'
  | 'not-finished'
  | 'fresh'

/** A `since` that cannot be resolved, or a state a delta cannot start on. */
export class ImportSinceError extends Error {
  readonly reason: ImportSinceReason
  constructor(reason: ImportSinceReason, message: string) {
    super(message)
    this.name = 'ImportSinceError'
    this.reason = reason
  }
}

const SINCE_FORMAT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

const invalid = (value: string) =>
  new ImportSinceError(
    'invalid',
    `--since ${value} is not last, a date (2026-10-01) or a date-time with a zone (2026-10-01T10:00:00Z, or +02:00 for an offset)`,
  )

/** The instant a date (UTC midnight) or a zoned date-time names. */
function parseSince(value: string): number {
  const m = SINCE_FORMAT.exec(value)
  if (m === null) throw invalid(value)
  const [, y, mo, d, h, mi, s, zone] = m
  if (h !== undefined && zone === undefined) {
    throw new ImportSinceError(
      'invalid',
      `--since ${value} has no time zone, so it names no one instant: add Z or an offset such as +02:00`,
    )
  }
  const parts = [y, mo, d, h, mi, s].map((p) => Number(p ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const [year, month, day, hour, minute, second] = parts
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Date.UTC rolls a field out of range into the next one (2026-13-01 is in 2027): refuse it rather than move the date.
  const read = [
    at.getUTCFullYear(),
    at.getUTCMonth() + 1,
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
  ]
  if (read.some((n, i) => n !== parts[i])) throw invalid(value)
  if (zone === undefined || zone === 'Z') return at.getTime()
  const offsetHours = Number(zone.slice(1, 3))
  const offsetMinutes = Number(zone.slice(4, 6))
  if (offsetHours > 23 || offsetMinutes > 59) throw invalid(value)
  const sign = zone.startsWith('-') ? -1 : 1
  return at.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000
}

/** As the WooCommerce API takes it: UTC, to the second. */
const toSecond = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`

/**
 * Each entity's `since`: for `last`, the start of the last finished pass that covered it; for a date or a zoned
 * date-time, that instant. An entity no finished pass covered is read whole (`null`) under either: a delta creates only
 * what the maps lack, so reading it whole is safe, and a date could miss what an unfinished pass never read.
 */
export function resolveSince(value: string, state: ImportState | null): SinceByEntity {
  const at = value === 'last' ? null : toSecond(parseSince(value))
  if (state === null) {
    throw new ImportSinceError(
      'no-state',
      'There is no import state (.nymbal-migration.json) to bring changes over to: run nymbal import first.',
    )
  }
  if (value === 'last' && state.runs.length === 0) {
    throw new ImportSinceError(
      'no-finished-run',
      'No import has finished yet, so --since last has nothing to start from: run nymbal import to finish it.',
    )
  }
  return Object.fromEntries(
    ENTITIES.map((e) => {
      const covering = state.runs.filter((r) => r.entities.includes(e)).at(-1)
      if (covering === undefined) return [e, null]
      return [e, at ?? toSecond(Date.parse(covering.startedAt))]
    }),
  ) as SinceByEntity
}

const DAY_MS = 86_400_000

/**
 * The query a delta pass adds to an entity's list. WooCommerce filters products and orders by when they changed and
 * reviews by when they were published; it cannot filter categories, customers or a product's variations.
 */
export function deltaParams(
  entity: ImportEntity,
  since: SinceByEntity | undefined,
): Record<string, string> {
  const at = since?.[entity]
  if (at === undefined || at === null) return {}
  if (entity === 'products' || entity === 'orders') {
    return { modified_after: at, dates_are_gmt: 'true' }
  }
  if (entity === 'reviews') {
    // WooCommerce reads a review's `after` in the site's own zone: a day earlier covers every zone, and a review read
    // again is already in the review map.
    return { after: new Date(Date.parse(at) - DAY_MS).toISOString().slice(0, 19) }
  }
  return {}
}

const imageHash = (src: string) => createHash('sha256').update(src).digest('hex').slice(0, 16)

/** Whether the stored media are the source's images, in order: the media key names each `src` by its hash. */
function sameImages(
  stored: ProductSnapshot['media'],
  images: Array<{ src: string; alt: string }>,
): boolean {
  const media = [...stored].sort((a, b) => a.position - b.position)
  return (
    media.length === images.length &&
    media.every((m, i) => {
      const file = m.url.split('/').at(-1) ?? ''
      return (
        file.split('.')[0] === imageHash(images[i]!.src) && m.altText === (images[i]!.alt || '')
      )
    })
  )
}

const sameSet = (a: string[], b: string[]) => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((x) => right.has(x))
}

export interface ProductChanges {
  /** Whether the product was written. */
  written: boolean
  warnings: ImportWarning[]
  /** Why the product kept its stored media though its images changed; null when it did not. */
  mediaError: string | null
}

/**
 * Brings an imported product to what WooCommerce lists for it now, writing it only when something differs: its copy,
 * status, SEO, categories, media and the prices of variants matched by SKU. The slug, the type, the variants themselves
 * and their stock stay as imported; a variant or type that no longer matches is a warning. An enriched product keeps
 * the AI's copy.
 */
export async function applyProductChanges(
  wc: WcProduct,
  variations: WcVariation[],
  categoryIds: string[],
  stored: ProductSnapshot,
  deps: { product: ProductService; media: MediaStorage; imagePolicy: ImagePolicy },
): Promise<ProductChanges> {
  const id = String(wc.id)
  const warnings: ImportWarning[] = []

  // Mapped under the stored slug, so a variant's fallback SKU comes out as it did at import.
  const suffix = ['', id].find((s) => productSlug(wc, s) === stored.slug)
  const source = suffix === undefined ? { ...wc, slug: stored.slug } : wc

  const images = imageSources(wc.images)
  let media: Array<{ url: string; altText: string }> | null = null
  let mediaError: string | null = null
  if (!sameImages(stored.media, images)) {
    const failures: string[] = []
    const downloaded = await downloadProductImages(
      images,
      stored.slug,
      deps.media,
      (err) => failures.push(String(err)),
      deps.imagePolicy,
    )
    if (downloaded.length === images.length) {
      media = downloaded
    } else {
      mediaError = [
        `${images.length - downloaded.length} of ${images.length} images could not be stored; the product keeps the images it had`,
        ...failures,
      ].join(': ')
    }
  }

  const mapped = mapProduct(source, variations, categoryIds, media ?? [], suffix ?? '')

  const storedBySku = new Map(stored.variants.map((v) => [v.sku, v]))
  const mappedSkus = new Set((mapped.variants ?? []).map((v) => v.sku))
  if (mapped.type !== stored.type) {
    warnings.push({
      phase: 'products',
      id,
      message: `WooCommerce product ${id} changed from ${stored.type} to ${mapped.type} (SKU ${[...mappedSkus].join(', ')}); its type and variants stay as imported`,
    })
  } else {
    for (const sku of mappedSkus) {
      if (storedBySku.has(sku)) continue
      warnings.push({
        phase: 'products',
        id,
        message: `WooCommerce product ${id} has a variation SKU ${sku} that was not imported; it is not added`,
      })
    }
    for (const sku of storedBySku.keys()) {
      if (mappedSkus.has(sku)) continue
      warnings.push({
        phase: 'products',
        id,
        message: `WooCommerce product ${id} no longer has the variation SKU ${sku}; it stays in the store`,
      })
    }
  }

  const prices: VariantPriceInput[] = []
  for (const v of mapped.variants ?? []) {
    const before = storedBySku.get(v.sku)
    if (before === undefined) continue
    const compareAtPriceMinor = v.compareAtPriceMinor ?? null
    if (v.priceMinor === before.priceMinor && compareAtPriceMinor === before.compareAtPriceMinor)
      continue
    prices.push({ id: before.id, priceMinor: v.priceMinor, compareAtPriceMinor })
  }

  const storedWoo = (stored.metadata['woocommerce'] ?? {}) as Record<string, unknown>
  const enriched = storedWoo['enriched'] === true
  const copy = enriched
    ? {}
    : {
        description: mapped.description ?? '',
        shortDescription: mapped.shortDescription ?? '',
        seoTitle: mapped.seoTitle ?? '',
        seoDescription: mapped.seoDescription ?? '',
      }
  const fields = { name: mapped.name, status: mapped.status ?? stored.status, ...copy }
  // The store keeps a description sanitized: compare it in that form.
  const asStored: Record<string, unknown> = {
    ...fields,
    ...(copy.description !== undefined && { description: sanitizeDescription(copy.description) }),
  }
  const differs =
    Object.entries(asStored).some(([k, v]) => stored[k as keyof ProductSnapshot] !== v) ||
    !sameSet(stored.categoryIds, mapped.categoryIds ?? []) ||
    media !== null ||
    prices.length > 0
  if (!differs) return { written: false, warnings, mediaError }

  await deps.product.update(stored.id, {
    ...fields,
    categoryIds: mapped.categoryIds ?? [],
    ...(media !== null && { media: mapped.media ?? [] }),
    ...(prices.length > 0 && { variants: prices }),
    metadata: {
      ...stored.metadata,
      woocommerce: {
        ...storedWoo,
        ...(mapped.metadata?.['woocommerce'] as Record<string, unknown>),
      },
    },
  })
  return { written: true, warnings, mediaError }
}
