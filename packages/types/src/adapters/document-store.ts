export interface PutOptions {
  ttl?: number
  conditionKey?: string
  conditionValue?: unknown
}

export interface QueryParams {
  partitionKey: { field: string; value: unknown }
  sortKey?: {
    field: string
    operator: 'eq' | 'gt' | 'lt' | 'between'
    value: unknown
  }
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
