import type { ImportEntity, ImportPlan, ImportReport, ImportWarning } from '../types.js'

export type DiffField = 'name' | 'price' | 'variants' | 'images' | 'categories'

export const DIFF_FIELDS: readonly DiffField[] = ['name', 'price', 'variants', 'images', 'categories']

export interface ProductDiff {
  wcId: number
  slug: string
  name: string
  changes: Array<{ field: DiffField; source: string; preview: string }>
}

export interface RedirectRow {
  from: string
  to: string
  status: 301
}

export interface Unredirected {
  kind: 'product' | 'category'
  wcId: number
  reason: string
}

export interface PreviewCounts {
  source: number
  planned: number
  imported: number
  refused: number
  skipped: number
  /** What the preview's API serves: products and categories only, null for the rest. */
  served: number | null
}

/** What a preview found: the import's counts against what its storefront serves, and where the two differ. */
export interface PreviewReport {
  /** Origin and path only: no credentials, no query. */
  source: { url: string }
  generatedAt: string
  currency: string
  entities: ImportEntity[]
  counts: Record<ImportEntity, PreviewCounts>
  errors: ImportReport['errors']
  warnings: ImportWarning[]
  unmapped: ImportPlan['unmapped']
  notListed: Array<{ wcId: number; slug: string; name: string }>
  differences: { byField: Record<DiffField, number>; products: ProductDiff[] }
  redirects: {
    rows: number
    unredirected: Unredirected[]
    duplicates: Array<{ from: string; wcIds: number[] }>
  }
}
