export interface WooCommerceCredentials {
  url: string
  consumerKey: string
  consumerSecret: string
}

export type ImportEntity = 'categories' | 'products' | 'customers' | 'orders' | 'reviews'

/** Each entity's `since` (`YYYY-MM-DDTHH:MM:SSZ`); `null` reads the entity whole, as a pass that never covered it must. */
export type SinceByEntity = Partial<Record<ImportEntity, string | null>>

/** Something a merchant should look at before launch that is not an error: the record was handled, partly. */
export interface ImportWarning {
  phase: string
  id?: string
  message: string
}

/** A pass that reached its end: every entity it covered was read from its first page to its last. */
export interface FinishedPass {
  /** When the pass began, not when its last resumed run began. */
  startedAt: string
  finishedAt: string
  /** Present for a delta pass. */
  since?: SinceByEntity
  /** The entities whose loops reached their end within the pass. */
  entities: ImportEntity[]
}

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
  /** The stock an item WooCommerce does not count imports with when it is in stock or on backorder; 1000 by default. */
  untrackedStock?: number
  /** Starts a delta pass on a state whose last pass finished; resolve `last` with `resolveSince`. */
  since?: SinceByEntity
}

export interface ImportCursor {
  page: number
}

export interface ImportState {
  source: 'woocommerce'
  startedAt: string
  /** When the earliest run whose records the state holds began: the store's own activity is counted from here. */
  rollbackSince: string
  phase: ImportEntity | 'connect' | 'enrich' | 'done'
  /**
   * The entities whose loop ran to its end: a later run imports only the selected entities not in it. A delta pass
   * starts it empty and holds there what it has covered.
   */
  finished: ImportEntity[]
  cursors: Partial<Record<ImportEntity, ImportCursor>>
  /** The records the import created (not those it only linked): what a rollback removes. */
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
  wcToNymbalOrder: Record<string, string>
  wcToNymbalReview: Record<string, string>
  errors: Array<{ phase: string; id?: string; error: string }>
  /** Each once, by phase, id and message. */
  warnings: ImportWarning[]
  eventsEmitted: number
  /** The finished passes, oldest first. */
  runs: FinishedPass[]
  /** Set while a delta pass is under way; a run without `since` resumes it. */
  delta?: {
    since: SinceByEntity
    startedAt: string
    updated: { products: number }
    changedNotUpdated: { orders: number }
    /** The products the pass created, kept across a stop: the ones `--ai` enriches when the pass ends. */
    created: { products: string[] }
  }
}

export interface ImportReport {
  imported: Record<ImportEntity, number>
  enriched: { enriched: number; skipped: number; failed: number }
  errors: ImportState['errors']
  warnings: ImportWarning[]
  /** Imported products a delta wrote WooCommerce's changes to. */
  updated: { products: number }
  /** Imported orders a delta listed as changed, which are never written again. */
  changedNotUpdated: { orders: number }
  /** Present when the run was part of a delta pass: each covered entity's `since`. */
  since?: SinceByEntity
  eventsEmitted: number
  durationMs: number
}

/** What a rollback will remove, and what it keeps. */
export interface RollbackPlan {
  remove: Record<ImportEntity, number>
  /** Image URLs the products to remove hold; their objects stay in media storage. */
  mediaUrls: number
  /** Customers that were in the store before the import, which it linked its orders to. */
  linkedCustomersKept: number
}

export interface RollbackReport extends RollbackPlan {
  removed: Record<ImportEntity, number>
  /** Records already gone when the rollback reached them. */
  absent: Record<ImportEntity, number>
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
