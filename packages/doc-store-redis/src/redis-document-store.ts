import { Redis } from 'ioredis'
import {
  AdapterError,
  boundedHealthCheck,
  connectionSecrets,
  HEALTH_CHECK_TIMEOUT_MS,
  queryDocuments,
  type DocumentStoreAdapter,
  type HealthReport,
  type Logger,
  type PutOptions,
  type QueryParams,
  type QueryResult,
} from '@nymbalhq/types'

export interface RedisDocumentStoreOptions {
  /** `redis://[user:password@]host:port[/db]`; the db index in the path is honoured. */
  url: string
  /** Namespaces every key the store writes: `<prefix>:doc:<collection>` and its expiry index. */
  prefix: string
  logger?: Logger
  /** How often expired documents are removed (they are never returned once expired). 0 turns the sweep off. */
  sweepIntervalMs?: number
  now?: () => number
}

/** A stored document and when it expires (epoch ms), or null for never. */
interface Stored {
  d: unknown
  e: number | null
}

// Writes a document and keeps the collection's expiry index in step with it.
// KEYS: documents hash, expiry zset, expiring-collections set. ARGV: key, stored JSON, expiresAt or '', collection.
const PUT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] == '' then
  redis.call('ZREM', KEYS[2], ARGV[1])
else
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
  redis.call('SADD', KEYS[3], ARGV[4])
end
return 1
`

// The same write, only when the live document's field is strictly equal to the expected value (JavaScript `===`:
// objects and arrays never are). ARGV[5]: the field; ARGV[6]: the expected value as JSON, or '' for undefined;
// ARGV[7]: now (epoch ms).
const PUT_IF = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then return 'absent' end
local stored = cjson.decode(current)
if stored.e ~= cjson.null and tonumber(stored.e) <= tonumber(ARGV[7]) then return 'absent' end
local actual = nil
if type(stored.d) == 'table' then actual = stored.d[ARGV[5]] end
if ARGV[6] == '' then
  if actual ~= nil then return 'mismatch' end
else
  local expected = cjson.decode(ARGV[6])
  if type(expected) == 'table' or type(actual) == 'table' then return 'mismatch' end
  if actual ~= expected then return 'mismatch' end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] == '' then
  redis.call('ZREM', KEYS[2], ARGV[1])
else
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
  redis.call('SADD', KEYS[3], ARGV[4])
end
return 'ok'
`

// Removes up to ARGV[2] documents whose expiry has passed at ARGV[1], checking each again under the script, so a
// document written again since it was indexed is kept.
const SWEEP = `
local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, key in ipairs(due) do
  local current = redis.call('HGET', KEYS[1], key)
  if current then
    local stored = cjson.decode(current)
    if stored.e ~= cjson.null and tonumber(stored.e) <= tonumber(ARGV[1]) then
      redis.call('HDEL', KEYS[1], key)
    end
  end
  redis.call('ZREM', KEYS[2], key)
end
return #due
`

type Script = (...args: Array<string | number>) => Promise<unknown>
interface Scripted {
  nymbalPut: Script
  nymbalPutIf: Script
  nymbalSweep: Script
}

const SWEEP_BATCH = 500

/** A document store on Redis: one hash per collection under the prefix, ordered and filtered by the reference. */
export class RedisDocumentStore implements DocumentStoreAdapter {
  readonly #client: Redis & Scripted
  readonly #url: string
  readonly #prefix: string
  readonly #now: () => number
  readonly #logger: Logger | undefined
  #sweepTimer: NodeJS.Timeout | null = null

  constructor(client: Redis, options: RedisDocumentStoreOptions) {
    client.defineCommand('nymbalPut', { numberOfKeys: 3, lua: PUT })
    client.defineCommand('nymbalPutIf', { numberOfKeys: 3, lua: PUT_IF })
    client.defineCommand('nymbalSweep', { numberOfKeys: 2, lua: SWEEP })
    this.#client = client as Redis & Scripted
    this.#url = options.url
    this.#prefix = options.prefix
    this.#now = options.now ?? Date.now
    this.#logger = options.logger
    const interval = options.sweepIntervalMs ?? 60_000
    if (interval > 0) {
      this.#sweepTimer = setInterval(() => void this.sweep(), interval)
      this.#sweepTimer.unref()
    }
  }

  capabilities(): readonly string[] {
    return ['get', 'put', 'delete', 'query', 'batch', 'ttl', 'conditional-put']
  }

  healthCheck(): Promise<HealthReport> {
    return pingRedis(this.#url)
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    const raw = await this.#client.hget(this.#docs(collection), key)
    return this.#live<T>(raw)
  }

  async put<T>(
    collection: string,
    key: string,
    document: T,
    options: PutOptions = {},
  ): Promise<void> {
    const expiresAt = options.ttl !== undefined ? this.#now() + options.ttl * 1000 : null
    const stored = JSON.stringify({ d: document, e: expiresAt } satisfies Stored)
    const keys = [this.#docs(collection), this.#expiry(collection), this.#expiring()]
    const args = [key, stored, expiresAt === null ? '' : String(expiresAt), collection]
    if (options.conditionKey === undefined) {
      await this.#client.nymbalPut(...keys, ...args)
      return
    }
    const expected =
      options.conditionValue === undefined ? '' : JSON.stringify(options.conditionValue)
    const outcome = await this.#client.nymbalPutIf(
      ...keys,
      ...args,
      options.conditionKey,
      expected,
      this.#now(),
    )
    if (outcome !== 'ok') {
      throw new AdapterError(
        'condition-failed',
        outcome === 'absent'
          ? `Condition failed on ${collection}/${key}: document does not exist`
          : `Condition failed on ${collection}/${key}: ${options.conditionKey} mismatch`,
        { context: { collection, key, conditionKey: options.conditionKey } },
      )
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.#client
      .multi()
      .hdel(this.#docs(collection), key)
      .zrem(this.#expiry(collection), key)
      .exec()
  }

  async query<T>(collection: string, params: QueryParams): Promise<QueryResult<T>> {
    const all = await this.#client.hgetall(this.#docs(collection))
    const live: Array<[string, unknown]> = []
    for (const [key, raw] of Object.entries(all)) {
      const stored = this.#decode(raw)
      if (stored !== null) live.push([key, stored.d])
    }
    return queryDocuments<T>(live, params)
  }

  async batchGet<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>()
    if (keys.length === 0) return result
    const values = await this.#client.hmget(this.#docs(collection), ...keys)
    keys.forEach((key, i) => {
      const doc = this.#live<T>(values[i] ?? null)
      if (doc !== null) result.set(key, doc)
    })
    return result
  }

  async batchPut<T>(collection: string, items: Map<string, T>): Promise<void> {
    if (items.size === 0) return
    const fields: string[] = []
    for (const [key, doc] of items) fields.push(key, JSON.stringify({ d: doc, e: null }))
    await this.#client
      .multi()
      .hset(this.#docs(collection), ...fields)
      .zrem(this.#expiry(collection), ...items.keys())
      .exec()
  }

  /** Removes every document whose TTL has passed. Reads never return them in the meantime. */
  async sweep(): Promise<void> {
    try {
      const collections = await this.#client.smembers(this.#expiring())
      for (const collection of collections) {
        const now = this.#now()
        let removed: number
        // A full batch may have left more behind.
        do {
          removed = Number(
            await this.#client.nymbalSweep(
              this.#docs(collection),
              this.#expiry(collection),
              now,
              SWEEP_BATCH,
            ),
          )
        } while (removed === SWEEP_BATCH)
      }
    } catch (err) {
      this.#logger?.warn({ err }, 'redis document store: expired documents were not swept')
    }
  }

  async close(): Promise<void> {
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer)
    this.#sweepTimer = null
    await this.#client.quit().catch(() => this.#client.disconnect())
  }

  #docs(collection: string): string {
    return `${this.#prefix}:doc:${collection}`
  }

  #expiry(collection: string): string {
    return `${this.#prefix}:exp:${collection}`
  }

  #expiring(): string {
    return `${this.#prefix}:expiring`
  }

  #decode(raw: string | null): Stored | null {
    if (raw === null) return null
    const stored = JSON.parse(raw) as Stored
    if (stored.e !== null && stored.e <= this.#now()) return null
    return stored
  }

  #live<T>(raw: string | null): T | null {
    const stored = this.#decode(raw)
    return stored === null ? null : (stored.d as T)
  }
}

/**
 * PING on a client of its own that never retries and queues nothing, disconnected afterwards: the store's or bus's own
 * clients retry a closed port for as long as the process lives, so they cannot answer within the bound.
 */
function pingRedis(url: string, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthReport> {
  const client = new Redis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
  })
  // connect() rejects with the same error, and the report carries it; without a listener ioredis would throw it.
  client.on('error', () => undefined)
  return boundedHealthCheck(
    async () => {
      await client.connect()
      await client.ping()
      return { status: 'healthy' }
    },
    { timeoutMs, redact: connectionSecrets(url) },
  ).finally(() => client.disconnect())
}

/** Connects to `url` and resolves once the connection is ready; a server that cannot be reached rejects. */
export async function connectRedis(url: string, logger?: Logger): Promise<Redis> {
  const client = new Redis(url, { lazyConnect: true })
  client.on('error', (err: Error) => logger?.warn({ err }, 'redis connection error'))
  try {
    await client.connect()
  } catch (error) {
    client.disconnect()
    throw error
  }
  return client
}

export async function createRedisDocumentStore(
  options: RedisDocumentStoreOptions,
): Promise<RedisDocumentStore> {
  const client = await connectRedis(options.url, options.logger)
  return new RedisDocumentStore(client, options)
}
