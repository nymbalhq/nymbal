import { AdapterError, queryDocuments } from '@nymbalhq/types'
import type {
  DocumentStoreAdapter,
  HealthReport,
  PutOptions,
  QueryParams,
  QueryResult,
} from '@nymbalhq/types'

interface Entry {
  doc: unknown
  expiresAt: number | null
}

export interface InMemoryDocumentStoreOptions {
  sweepIntervalMs?: number
  now?: () => number
}

export class InMemoryDocumentStore implements DocumentStoreAdapter {
  readonly #data = new Map<string, Map<string, Entry>>()
  readonly #now: () => number
  readonly #sweepTimer: NodeJS.Timeout | null

  constructor(options: InMemoryDocumentStoreOptions = {}) {
    this.#now = options.now ?? Date.now
    const interval = options.sweepIntervalMs ?? 60_000
    if (interval > 0) {
      this.#sweepTimer = setInterval(() => this.#sweep(), interval)
      this.#sweepTimer.unref?.()
    } else {
      this.#sweepTimer = null
    }
  }

  capabilities(): readonly string[] {
    return ['get', 'put', 'delete', 'query', 'batch', 'ttl', 'conditional-put']
  }

  /** The process's own memory: healthy whenever it can answer. */
  async healthCheck(): Promise<HealthReport> {
    return { status: 'healthy' }
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    const entry = this.#data.get(collection)?.get(key)
    if (!entry) return null
    if (this.#isExpired(entry)) {
      this.#data.get(collection)?.delete(key)
      return null
    }
    return entry.doc as T
  }

  async put<T>(
    collection: string,
    key: string,
    document: T,
    options: PutOptions = {},
  ): Promise<void> {
    const bucket = this.#getOrCreate(collection)
    if (options.conditionKey !== undefined) {
      const existing = bucket.get(key)
      if (!existing || this.#isExpired(existing)) {
        throw new AdapterError(
          'condition-failed',
          `Condition failed on ${collection}/${key}: document does not exist`,
          { context: { collection, key, conditionKey: options.conditionKey } },
        )
      }
      const actual = (existing.doc as Record<string, unknown>)[options.conditionKey]
      if (actual !== options.conditionValue) {
        throw new AdapterError(
          'condition-failed',
          `Condition failed on ${collection}/${key}: ${options.conditionKey} mismatch`,
          {
            context: {
              collection,
              key,
              conditionKey: options.conditionKey,
              expected: options.conditionValue,
              actual,
            },
          },
        )
      }
    }
    const expiresAt = options.ttl !== undefined ? this.#now() + options.ttl * 1000 : null
    bucket.set(key, { doc: document, expiresAt })
  }

  async delete(collection: string, key: string): Promise<void> {
    this.#data.get(collection)?.delete(key)
  }

  async query<T>(collection: string, params: QueryParams): Promise<QueryResult<T>> {
    const bucket = this.#data.get(collection)
    if (!bucket) return { items: [], nextCursor: null }
    const live: Array<[string, unknown]> = []
    for (const [key, entry] of bucket) {
      if (!this.#isExpired(entry)) live.push([key, entry.doc])
    }
    return queryDocuments<T>(live, params)
  }

  async batchGet<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>()
    for (const key of keys) {
      const value = await this.get<T>(collection, key)
      if (value !== null) result.set(key, value)
    }
    return result
  }

  async batchPut<T>(collection: string, items: Map<string, T>): Promise<void> {
    for (const [key, doc] of items) {
      await this.put(collection, key, doc)
    }
  }

  async close(): Promise<void> {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer)
    this.#data.clear()
  }

  #getOrCreate(collection: string): Map<string, Entry> {
    let bucket = this.#data.get(collection)
    if (!bucket) {
      bucket = new Map()
      this.#data.set(collection, bucket)
    }
    return bucket
  }

  #isExpired(entry: Entry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.#now()
  }

  #sweep(): void {
    const now = this.#now()
    for (const bucket of this.#data.values()) {
      for (const [key, entry] of bucket) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          bucket.delete(key)
        }
      }
    }
  }
}
