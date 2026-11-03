export interface WooCommerceCredentials {
  url: string
  consumerKey: string
  consumerSecret: string
}

export type ImportEntity = 'categories' | 'products' | 'customers' | 'orders' | 'reviews'

export interface WooCommerceImportOptions {
  credentials: WooCommerceCredentials
  entities: ImportEntity[]
  ai: boolean
  gdpr: boolean
  fresh: boolean
  concurrency: number
  projectRoot: string
  currency: string
  statePath: string
}

export interface ImportCursor {
  page: number
}

export interface ImportState {
  source: 'woocommerce'
  startedAt: string
  phase: ImportEntity | 'connect' | 'enrich' | 'done'
  cursors: Partial<Record<ImportEntity, ImportCursor>>
  importedIds: {
    categories: string[]
    products: string[]
    customers: string[]
    orders: string[]
    reviews: string[]
  }
  wcToNymbalCustomer: Record<string, string>
  wcToNymbalProduct: Record<string, string>
  wcToNymbalCategory: Record<string, string>
  errors: Array<{ phase: string; id?: string; error: string }>
  eventsEmitted: number
}

export interface ImportReport {
  imported: Record<ImportEntity, number>
  enriched: { enriched: number; skipped: number; failed: number }
  errors: ImportState['errors']
  eventsEmitted: number
  durationMs: number
}

export type ProgressCallback = (event: ProgressEvent) => void

export type ProgressEvent =
  | { kind: 'phase'; phase: string }
  | { kind: 'progress'; entity: string; done: number; total: number }
  | { kind: 'error'; phase: string; id: string; message: string }

/** What a plan reports fields for: each entity, and the variations read for variable products. */
export type PlanEntity = ImportEntity | 'variations'

export type CollisionKind = 'product-slug' | 'sku' | 'category-slug' | 'customer-email' | 'order-number'

/** What the target store already holds, asked read-only. `customerEmailExists` gets the email lowercased. */
export interface ExistingStoreLookup {
  productSlugExists(slug: string): Promise<boolean>
  skuExists(sku: string): Promise<boolean>
  categorySlugExists(slug: string): Promise<boolean>
  customerEmailExists(email: string): Promise<boolean>
  orderNumberExists(orderNumber: string): Promise<boolean>
}

export interface PlanCollision {
  kind: CollisionKind
  with: 'source' | 'store'
  /** The clashing slug, SKU or order number; `''` for a customer email, which is personal data. */
  value: string
  /** WooCommerce ids (a product's for a SKU); a source clash names the record that is imported too. */
  sourceIds: string[]
  outcome: 'refused' | 'links-existing'
}

export interface ImportPlan {
  /** Origin and path only: no credentials, no query. */
  source: { url: string }
  /** `import` is what the import's report will count; `source = import + refused + skipped`. */
  counts: Record<ImportEntity, { source: number; import: number; refused: number; skipped: number }>
  /** Source fields the import never reads, by how many records carry a value for them. */
  unmapped: Record<PlanEntity, Array<{ field: string; records: number }>>
  collisions: PlanCollision[]
  estimate: {
    requests: { api: number; images: number }
    meanRequestMs: number
    writes: number
    seconds: number
  }
  wontMigrate: Array<{ item: string; count: number | null; why: string }>
  existingStore: 'checked' | { notChecked: string }
  resumeStateFound: boolean
}
