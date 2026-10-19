export interface PutOptions {
  ttl?: number
  conditionKey?: string
  conditionValue?: unknown
}

export interface QueryParams {
  /** A `value` of `'*'` matches every document in the collection (a full scan). */
  partitionKey: { field: string; value: unknown }
  sortKey?: {
    field: string
    operator: 'eq' | 'gt' | 'lt' | 'between'
    value: unknown
  }
  /**
   * Orders the results without filtering them; `field` may be a dotted path (`priceRange.minMinor`). Ties break by
   * document key, ascending, so the order is total. A cursor issued under one `orderBy` is refused under another.
   */
  orderBy?: { field: string; direction: 'asc' | 'desc'; nulls?: 'last' }
  limit?: number
  cursor?: string
  ascending?: boolean
}

export interface QueryResult<T> {
  items: T[]
  nextCursor: string | null
}

export interface DocumentStoreAdapter {
  get<T>(collection: string, key: string): Promise<T | null>
  put<T>(collection: string, key: string, document: T, options?: PutOptions): Promise<void>
  delete(collection: string, key: string): Promise<void>
  query<T>(collection: string, params: QueryParams): Promise<QueryResult<T>>
  batchGet<T>(collection: string, keys: string[]): Promise<Map<string, T>>
  batchPut<T>(collection: string, items: Map<string, T>): Promise<void>
  close(): Promise<void>
}
