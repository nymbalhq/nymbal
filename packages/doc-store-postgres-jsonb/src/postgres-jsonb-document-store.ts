import pg from 'pg'
import {
  AdapterError,
  queryDocuments,
  type DocumentStoreAdapter,
  type Logger,
  type PutOptions,
  type QueryParams,
  type QueryResult,
} from '@nymbalhq/types'

export interface PostgresJsonbDocumentStoreOptions {
  /** The command store's database: the table lives beside the kernel's own. */
  postgresUrl: string
  /** Namespaces every row the store writes, so stores sharing a database never see each other's documents. */
  prefix: string
  logger?: Logger
  /** How often expired rows are deleted (they are never returned once expired). 0 turns the sweep off. */
  sweepIntervalMs?: number
  now?: () => number
}

const TABLE = 'nymbal_documents'
/** Serialises the table's DDL across replicas that start together: any constant every replica agrees on. */
const DDL_LOCK = 0x6e796d62

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    prefix text NOT NULL,
    collection text NOT NULL,
    key text NOT NULL,
    doc jsonb NOT NULL,
    expires_at timestamptz,
    PRIMARY KEY (prefix, collection, key)
  )`,
  // Narrows a partition query (`doc @> {"field": value}`) without a scan of the collection.
  `CREATE INDEX IF NOT EXISTS ${TABLE}_doc_idx ON ${TABLE} USING gin (doc jsonb_path_ops)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_expires_idx ON ${TABLE} (expires_at) WHERE expires_at IS NOT NULL`,
]

const LIVE = '(expires_at IS NULL OR expires_at > $NOW)'
const BATCH_ROWS = 500

/** A partition value the GIN index can narrow by: the store still filters with `===` afterwards. */
function narrowable(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * A document store on Postgres JSONB: one table, `nymbal_documents`, owned by the store and created by `initialize()`.
 * It holds derived data the kernel rebuilds at every start, so it is not a kernel migration.
 */
export class PostgresJsonbDocumentStore implements DocumentStoreAdapter {
  readonly #pool: pg.Pool
  readonly #prefix: string
  readonly #now: () => number
  readonly #logger: Logger | undefined
  readonly #sweepIntervalMs: number
  #sweepTimer: NodeJS.Timeout | null = null

  constructor(options: PostgresJsonbDocumentStoreOptions) {
    this.#pool = new pg.Pool({ connectionString: options.postgresUrl, max: 5 })
    this.#pool.on('error', (err) => options.logger?.warn({ err }, 'postgres jsonb pool error'))
    this.#prefix = options.prefix
    this.#now = options.now ?? Date.now
    this.#logger = options.logger
    this.#sweepIntervalMs = options.sweepIntervalMs ?? 60_000
  }

  capabilities(): readonly string[] {
    return ['get', 'put', 'delete', 'query', 'batch', 'ttl', 'conditional-put']
  }

  /** Creates the table and its indexes when absent, under an advisory lock; safe to call again. */
  async initialize(): Promise<void> {
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock($1)', [DDL_LOCK])
      for (const statement of DDL) await client.query(statement)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    if (this.#sweepTimer === null && this.#sweepIntervalMs > 0) {
      this.#sweepTimer = setInterval(() => void this.sweep(), this.#sweepIntervalMs)
      this.#sweepTimer.unref()
    }
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    const { rows } = await this.#pool.query<{ doc: T }>(
      `SELECT doc FROM ${TABLE} WHERE prefix = $1 AND collection = $2 AND key = $3 AND ${this.#live(4)}`,
      [this.#prefix, collection, key, this.#nowDate()],
    )
    return rows[0]?.doc ?? null
  }

  async put<T>(
    collection: string,
    key: string,
    document: T,
    options: PutOptions = {},
  ): Promise<void> {
    const expiresAt = options.ttl !== undefined ? new Date(this.#now() + options.ttl * 1000) : null
    const doc = JSON.stringify(document)
    if (options.conditionKey === undefined) {
      await this.#pool.query(
        `INSERT INTO ${TABLE} (prefix, collection, key, doc, expires_at) VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (prefix, collection, key) DO UPDATE SET doc = EXCLUDED.doc, expires_at = EXCLUDED.expires_at`,
        [this.#prefix, collection, key, doc, expiresAt],
      )
      return
    }
    const conditionKey = options.conditionKey
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ doc: Record<string, unknown> }>(
        `SELECT doc FROM ${TABLE} WHERE prefix = $1 AND collection = $2 AND key = $3 AND ${this.#live(4)}
         FOR UPDATE`,
        [this.#prefix, collection, key, this.#nowDate()],
      )
      const current = rows[0]?.doc
      // `===`, as the reference store compares: an object or array never matches.
      const holds = current !== undefined && current[conditionKey] === options.conditionValue
      if (!holds) {
        await client.query('ROLLBACK')
        throw new AdapterError(
          'condition-failed',
          current === undefined
            ? `Condition failed on ${collection}/${key}: document does not exist`
            : `Condition failed on ${collection}/${key}: ${conditionKey} mismatch`,
          { context: { collection, key, conditionKey } },
        )
      }
      await client.query(
        `UPDATE ${TABLE} SET doc = $4::jsonb, expires_at = $5 WHERE prefix = $1 AND collection = $2 AND key = $3`,
        [this.#prefix, collection, key, doc, expiresAt],
      )
      await client.query('COMMIT')
    } catch (error) {
      if (!(error instanceof AdapterError)) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.#pool.query(
      `DELETE FROM ${TABLE} WHERE prefix = $1 AND collection = $2 AND key = $3`,
      [this.#prefix, collection, key],
    )
  }

  async query<T>(collection: string, params: QueryParams): Promise<QueryResult<T>> {
    const { field, value } = params.partitionKey
    const narrow = value !== '*' && narrowable(value)
    const { rows } = await this.#pool.query<{ key: string; doc: unknown }>(
      `SELECT key, doc FROM ${TABLE} WHERE prefix = $1 AND collection = $2 AND ${this.#live(3)}` +
        (narrow ? ' AND doc @> $4::jsonb' : ''),
      [
        this.#prefix,
        collection,
        this.#nowDate(),
        ...(narrow ? [JSON.stringify({ [field]: value })] : []),
      ],
    )
    return queryDocuments<T>(
      rows.map((r) => [r.key, r.doc] as const),
      params,
    )
  }

  async batchGet<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>()
    if (keys.length === 0) return result
    const { rows } = await this.#pool.query<{ key: string; doc: T }>(
      `SELECT key, doc FROM ${TABLE} WHERE prefix = $1 AND collection = $2 AND key = ANY($3::text[]) AND ${this.#live(4)}`,
      [this.#prefix, collection, keys, this.#nowDate()],
    )
    const byKey = new Map(rows.map((r) => [r.key, r.doc]))
    for (const key of keys) {
      const doc = byKey.get(key)
      if (doc !== undefined) result.set(key, doc)
    }
    return result
  }

  async batchPut<T>(collection: string, items: Map<string, T>): Promise<void> {
    const entries = [...items]
    for (let i = 0; i < entries.length; i += BATCH_ROWS) {
      const chunk = entries.slice(i, i + BATCH_ROWS)
      await this.#pool.query(
        `INSERT INTO ${TABLE} (prefix, collection, key, doc, expires_at)
         SELECT $1, $2, k, d, NULL FROM unnest($3::text[], $4::jsonb[]) AS t(k, d)
         ON CONFLICT (prefix, collection, key) DO UPDATE SET doc = EXCLUDED.doc, expires_at = NULL`,
        [
          this.#prefix,
          collection,
          chunk.map(([key]) => key),
          chunk.map(([, doc]) => JSON.stringify(doc)),
        ],
      )
    }
  }

  /** Deletes this prefix's expired rows. Reads never return them in the meantime. */
  async sweep(): Promise<void> {
    try {
      await this.#pool.query(`DELETE FROM ${TABLE} WHERE prefix = $1 AND expires_at <= $2`, [
        this.#prefix,
        this.#nowDate(),
      ])
    } catch (err) {
      this.#logger?.warn({ err }, 'postgres jsonb document store: expired rows were not swept')
    }
  }

  async close(): Promise<void> {
    if (this.#sweepTimer !== null) clearInterval(this.#sweepTimer)
    this.#sweepTimer = null
    await this.#pool.end()
  }

  /** The not-expired condition, with "now" as parameter `$n`: the store's clock, not the server's. */
  #live(n: number): string {
    return LIVE.replace('$NOW', `$${n}`)
  }

  #nowDate(): Date {
    return new Date(this.#now())
  }
}

export function createPostgresJsonbDocumentStore(
  options: PostgresJsonbDocumentStoreOptions,
): PostgresJsonbDocumentStore {
  return new PostgresJsonbDocumentStore(options)
}
