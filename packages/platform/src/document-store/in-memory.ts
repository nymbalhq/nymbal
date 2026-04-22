import { AdapterError } from '@nymbal/types'
import type {
  DocumentStoreAdapter,
  PutOptions,
  QueryParams,
  QueryResult,
} from '@nymbal/types'

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

    const ascending = params.ascending ?? true
    const limit = params.limit ?? 50
    const decodedCursor = params.cursor ? decodeCursor(params.cursor) : null

    const matches: Array<{ key: string; doc: Record<string, unknown> }> = []
    for (const [key, entry] of bucket) {
      if (this.#isExpired(entry)) continue
      const doc = entry.doc as Record<string, unknown>
      if (doc[params.partitionKey.field] !== params.partitionKey.value) continue
      if (params.sortKey) {
        const value = doc[params.sortKey.field]
        if (!sortKeyMatches(value, params.sortKey.operator, params.sortKey.value)) continue
      }
      matches.push({ key, doc })
    }

    const sortField = params.sortKey?.field
    matches.sort((a, b) => {
      const aKey = sortField ? a.doc[sortField] : a.key
      const bKey = sortField ? b.doc[sortField] : b.key
      const cmp = compare(aKey, bKey)
      return ascending ? cmp : -cmp
    })

    let start = 0
    if (decodedCursor) {
      const idx = matches.findIndex((m) => m.key === decodedCursor)
      start = idx >= 0 ? idx + 1 : 0
    }
    const page = matches.slice(start, start + limit)
    const nextCursor =
      start + limit < matches.length && page.length > 0
        ? encodeCursor(page[page.length - 1]!.key)
        : null
    return { items: page.map((m) => m.doc as T), nextCursor }
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

function sortKeyMatches(
  value: unknown,
  operator: 'eq' | 'gt' | 'lt' | 'between',
  target: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return value === target
    case 'gt':
      return compare(value, target) > 0
    case 'lt':
      return compare(value, target) < 0
    case 'between': {
      if (!Array.isArray(target) || target.length !== 2) return false
      const [low, high] = target
      return compare(value, low) >= 0 && compare(value, high) <= 0
    }
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : 1
}

function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8')
}
