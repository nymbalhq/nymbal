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
