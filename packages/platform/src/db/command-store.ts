import { AsyncLocalStorage } from 'node:async_hooks'
import type { NymbalConfig } from '@nymbalhq/config'
import { envOptional } from '@nymbalhq/config'
import { AdapterError, ConfigError } from '@nymbalhq/types'

import BetterSqlite3 from 'better-sqlite3'
import pg from 'pg'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import * as sqliteSchema from './schema/sqlite.js'
import * as postgresSchema from './schema/postgres.js'

export type SqliteClient = BetterSQLite3Database<typeof sqliteSchema>
export type PostgresClient = NodePgDatabase<typeof postgresSchema>

declare const readBrand: unique symbol
declare const writeBrand: unique symbol
/** A handle for reads: committed data, or the open transaction's view when one is open in the call chain. */
export interface ReadTx {
  readonly kind: 'sqlite' | 'postgres'
  readonly [readBrand]: true
}
/** A handle for writes: only `CommandStore.transaction` hands one out. */
export interface Tx extends ReadTx {
  readonly [writeBrand]: true
}

export interface CommandStore {
  readonly kind: 'sqlite' | 'postgres'
  /** Runs reads. Inside an open transaction (same async call chain) it uses that transaction's Tx; outside, committed
   *  data only (SQLite: it takes its turn on the queue; Postgres: a pool connection for the callback). */
  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T>
  /** Opens a transaction, or joins the one open in the same async call chain (no new BEGIN; commits and rolls back
   *  with the outermost). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /** Runs `fn` behind a savepoint in the transaction open in the same async call chain: if `fn` throws, its writes
   *  (and only its writes) are undone, the error is rethrown, and the enclosing transaction carries on. With no
   *  transaction open it is `transaction`. */
  savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** A repository over one command store. A caller handed only the repository (a projection, a sweeper) opens its
 *  reads and transactions on `store`. */
export interface StoreRepository {
  readonly store: CommandStore
}

export type RawClients =
  | { kind: 'sqlite'; db: SqliteClient; raw: BetterSqlite3.Database }
  | { kind: 'postgres'; db: PostgresClient; pool: pg.Pool }

export interface CommandStoreOptions {
  sqlitePath?: string
  postgresUrl?: string
  /**
   * For a caller that must change nothing: SQLite opens `readonly` on a file that must already exist, with no pragma
   * (`journal_mode = WAL` rewrites a rollback-mode file's header); Postgres runs every transaction read-only.
   */
  readOnly?: boolean
}

type Client = { kind: 'sqlite'; db: SqliteClient } | { kind: 'postgres'; db: PostgresClient }

/**
 * One `read` or outermost `transaction` callback and everything it awaits. It is also the handle the callback gets as
 * its `ReadTx` or `Tx`.
 */
class Scope {
  settled = false
  /** The first rejection of a joined block: the outermost rolls back even if a caller swallowed it. */
  failure: { error: unknown } | undefined
  /** Sends held until the outermost commits; the same function held twice runs once. */
  readonly held = new Set<() => Promise<void>>()
  /** Savepoints opened so far, for unique names. */
  savepoints = 0

  constructor(
    readonly owner: object,
    readonly client: Client,
    readonly writable: boolean,
    /** Runs one SQL statement on the transaction's connection; reads have none. */
    readonly exec?: (sql: string) => Promise<void>,
  ) {}

  get kind(): Client['kind'] {
    return this.client.kind
  }
}

const context = new AsyncLocalStorage<Scope>()
const rawByStore = new WeakMap<CommandStore, RawClients>()
const turnByRaw = new WeakMap<BetterSqlite3.Database, <T>(fn: () => T) => Promise<T>>()

/**
 * Runs `fn`, synchronous statements on a SQLite store's raw connection, in that store's turn: at once inside this
 * call chain's open read or transaction of the store, otherwise once the connection is free, as a read waits. A
 * transaction holds the one connection across awaits, so a statement run on `raw` outside its turn would join, and
 * roll back with, whichever transaction another call chain has open. For code handed only `rawClients`.
 */
export async function sqliteTurn<T>(raw: BetterSqlite3.Database, fn: () => T): Promise<T> {
  const turn = turnByRaw.get(raw)
  return turn === undefined ? fn() : turn(fn)
}

function liveScope(tx: ReadTx): Scope {
  if (!(tx instanceof Scope)) {
    throw new TypeError('expected a handle from CommandStore.read or CommandStore.transaction')
  }
  if (tx.settled) {
    throw new Error('a command-store handle was used after its read or transaction settled')
  }
  return tx
}

/** The SQLite Drizzle client behind a handle. For repositories. */
export function sqliteDb(tx: ReadTx): SqliteClient {
  const { client } = liveScope(tx)
  if (client.kind !== 'sqlite') throw new TypeError('expected a SQLite handle')
  return client.db
}

/** The Postgres Drizzle client behind a handle: the transaction's (or read's) own connection. For repositories. */
export function postgresDb(tx: ReadTx): PostgresClient {
  const { client } = liveScope(tx)
  if (client.kind !== 'postgres') throw new TypeError('expected a Postgres handle')
  return client.db
}

/**
 * Runs `send` now, or, inside an open transaction, holds it until the outermost commits; a rollback drops it. The
 * same function held more than once in one transaction runs once. The publisher drains the event relay through here,
 * after the slot or connection is released, so subscribers only see committed writes.
 */
export async function afterCommit(send: () => Promise<void>): Promise<void> {
  const scope = context.getStore()
  if (scope !== undefined && scope.writable && !scope.settled) {
    scope.held.add(send)
    return
  }
  await send()
}

/** For migrations, seeding and tests only; no repository or service imports it. */
export function rawClients(store: CommandStore): RawClients {
  const clients = rawByStore.get(store)
  if (clients === undefined) throw new TypeError('not a store from createCommandStore')
  return clients
}

/** The open scope of this store in the current async call chain, if any. */
function joinable(owner: object): Scope | undefined {
  const scope = context.getStore()
  return scope !== undefined && scope.owner === owner && !scope.settled ? scope : undefined
}

async function join<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!scope.writable) {
    throw new Error(
      'CommandStore.transaction() was called inside CommandStore.read(); open the transaction first',
    )
  }
  try {
    return await fn(scope as unknown as Tx)
  } catch (error) {
    scope.failure ??= { error }
    throw error
  }
}

async function savepoint<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!scope.writable || scope.exec === undefined) {
    throw new Error(
      'CommandStore.savepoint() was called inside CommandStore.read(); open the transaction first',
    )
  }
  const exec = scope.exec
  const name = `nymbal_sp_${(scope.savepoints += 1)}`
  const failure = scope.failure
  const held = new Set(scope.held)
  await exec(`SAVEPOINT ${name}`)
  try {
    const result = await fn(scope as unknown as Tx)
    await exec(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    try {
      await exec(`ROLLBACK TO SAVEPOINT ${name}`)
      await exec(`RELEASE SAVEPOINT ${name}`)
    } catch (rollbackError) {
      scope.failure ??= { error: rollbackError }
      throw new AggregateError([error, rollbackError], 'savepoint failed and so did its rollback')
    }
    // The failure recorded inside, and the sends held inside, went with the writes the rollback undid.
    scope.failure = failure
    for (const send of scope.held) if (!held.has(send)) scope.held.delete(send)
    throw error
  }
}

interface Connection {
  client: Client
  /** One statement on the transaction's connection: savepoints. */
  exec(sql: string): Promise<void>
  begin(): Promise<void>
  /** Throws unless the transaction committed. */
  commit(): Promise<void>
  rollback(): Promise<void>
  /** `unusable`: the rollback failed, so the connection must not be reused. */
  release(unusable?: Error): void
}

async function deliver(held: Iterable<() => Promise<void>>): Promise<void> {
  let failed: { error: unknown } | undefined
  for (const send of held) {
    try {
      await send()
    } catch (error) {
      // The writes are committed: keep delivering the rest, then report the first failure.
      failed ??= { error }
    }
  }
  if (failed !== undefined) throw failed.error
}

async function runTransaction<T>(
  owner: object,
  connection: Connection,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const scope = new Scope(owner, connection.client, true, (sql) => connection.exec(sql))
  let result: T
  let begun = false
  let unusable: Error | undefined
  try {
    await connection.begin()
    begun = true
    try {
      result = await context.run(scope, () => fn(scope as unknown as Tx))
    } finally {
      // Once its callback has settled, nothing joins this transaction or writes through its handle.
      scope.settled = true
    }
    if (scope.failure !== undefined) throw scope.failure.error
    await connection.commit()
  } catch (error) {
    if (begun) {
      try {
        await connection.rollback()
      } catch (rollbackError) {
        unusable = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
        throw new AggregateError(
          [error, rollbackError],
          'transaction failed and so did its rollback',
        )
      }
    }
    throw error
  } finally {
    scope.settled = true
    connection.release(unusable)
  }
  // Delivered after the slot or connection is free and outside this transaction's context, so a subscriber that
  // reads or writes starts afresh instead of joining (or waiting on) the transaction that published.
  await context.exit(() => deliver(scope.held))
  return result
}

async function runRead<T>(
  owner: object,
  client: Client,
  release: () => void,
  fn: (tx: ReadTx) => Promise<T>,
): Promise<T> {
  const scope = new Scope(owner, client, false)
  try {
    return await context.run(scope, () => fn(scope as unknown as ReadTx))
  } finally {
    scope.settled = true
    release()
  }
}

/** One holder at a time, in arrival order. */
function createQueue(): { acquire(): Promise<() => void> } {
  let tail: Promise<void> = Promise.resolve()
  return {
    async acquire() {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      return release
    },
  }
}

/** How long a SQLite writer waits for another connection's write transaction: better-sqlite3's own default. */
const SQLITE_BUSY_WAIT_MS = 5000

/**
 * `BEGIN IMMEDIATE`, waiting for another connection's write transaction between event-loop turns. The driver's busy
 * handler sleeps the thread instead, so when the holder is another command store in this process it can never reach
 * its COMMIT, and every writer after the first fails with SQLITE_BUSY once the wait runs out.
 */
async function beginImmediate(raw: BetterSqlite3.Database): Promise<void> {
  const deadline = Date.now() + SQLITE_BUSY_WAIT_MS
  raw.pragma('busy_timeout = 0')
  try {
    for (let pauseMs = 1; ; pauseMs = Math.min(pauseMs * 2, 20)) {
      try {
        raw.exec('BEGIN IMMEDIATE')
        return
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) {
          throw error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
    }
  } finally {
    raw.pragma(`busy_timeout = ${SQLITE_BUSY_WAIT_MS}`)
  }
}

/** The SQLite file a store opens: `sqlitePath`, else `NYMBAL_SQLITE_PATH`, else `./nymbal.db`. */
export function sqliteFile(options: CommandStoreOptions = {}): string {
  return options.sqlitePath ?? envOptional('NYMBAL_SQLITE_PATH') ?? './nymbal.db'
}

export function createCommandStore(
  config: NymbalConfig,
  options: CommandStoreOptions = {},
): CommandStore {
  if (config.infrastructure.commandStore === 'sqlite') {
    const path = sqliteFile(options)
    const raw = options.readOnly
      ? new BetterSqlite3(path, { readonly: true, fileMustExist: true })
      : new BetterSqlite3(path)
    if (!options.readOnly) {
      raw.pragma('journal_mode = WAL')
      raw.pragma('foreign_keys = ON')
    }
    const db = drizzleSqlite(raw, { schema: sqliteSchema })
    const client: Client = { kind: 'sqlite', db }
    // One connection: a transaction holds it from BEGIN to COMMIT across awaits, so every other read and transaction
    // waits its turn here rather than interleaving its statements into the open transaction.
    const queue = createQueue()
    const owner = {}
    const store: CommandStore = {
      kind: 'sqlite',
      async read(fn) {
        const scope = joinable(owner)
        if (scope !== undefined) return fn(scope as unknown as ReadTx)
        return runRead(owner, client, await queue.acquire(), fn)
      },
      async transaction(fn) {
        const scope = joinable(owner)
        if (scope !== undefined) return join(scope, fn)
        const release = await queue.acquire()
        return runTransaction(
          owner,
          {
            client,
            async exec(sql) {
              raw.exec(sql)
            },
            begin: () => beginImmediate(raw),
            async commit() {
              raw.exec('COMMIT')
            },
            async rollback() {
              if (raw.inTransaction) raw.exec('ROLLBACK')
            },
            release,
          },
          fn,
        )
      },
      async savepoint(fn) {
        const scope = joinable(owner)
        return scope === undefined ? store.transaction(fn) : savepoint(scope, fn)
      },
      async close() {
        raw.close()
      },
    }
    rawByStore.set(store, { kind: 'sqlite', db, raw })
    turnByRaw.set(raw, async (fn) => {
      if (joinable(owner) !== undefined) return fn()
      const release = await queue.acquire()
      try {
        return fn()
      } finally {
        release()
      }
    })
    return store
  }

  if (config.infrastructure.commandStore === 'postgres') {
    const connectionString = options.postgresUrl ?? envOptional('DATABASE_URL')
    if (!connectionString) {
      throw new ConfigError(
        'commandStore=postgres requires DATABASE_URL to be set (or pass postgresUrl option).',
        { context: { commandStore: 'postgres' } },
      )
    }
    const pool = new pg.Pool({
      connectionString,
      ...(options.readOnly && { options: '-c default_transaction_read_only=on' }),
    })
    const db = drizzlePg(pool, { schema: postgresSchema })
    const owner = {}
    const connect = async (): Promise<{ client: Client; connection: pg.PoolClient }> => {
      const connection = await pool.connect()
      return {
        connection,
        client: { kind: 'postgres', db: drizzlePg(connection, { schema: postgresSchema }) },
      }
    }
    const store: CommandStore = {
      kind: 'postgres',
      async read(fn) {
        const scope = joinable(owner)
        if (scope !== undefined) return fn(scope as unknown as ReadTx)
        const { client, connection } = await connect()
        return runRead(owner, client, () => connection.release(), fn)
      },
      async transaction(fn) {
        const scope = joinable(owner)
        if (scope !== undefined) return join(scope, fn)
        const { client, connection } = await connect()
        return runTransaction(
          owner,
          {
            client,
            async exec(sql) {
              await connection.query(sql)
            },
            async begin() {
              await connection.query('BEGIN')
            },
            async commit() {
              // An aborted transaction answers COMMIT with ROLLBACK instead of an error.
              const result = await connection.query('COMMIT')
              if (result.command !== 'COMMIT') {
                throw new AdapterError(
                  'command_store.rolled_back',
                  'Postgres rolled the transaction back at COMMIT: a statement inside it failed',
                  { context: { command: result.command } },
                )
              }
            },
            async rollback() {
              await connection.query('ROLLBACK')
            },
            release(unusable) {
              // An error destroys the connection instead of returning it to the pool.
              connection.release(unusable)
            },
          },
          fn,
        )
      },
      async savepoint(fn) {
        const scope = joinable(owner)
        return scope === undefined ? store.transaction(fn) : savepoint(scope, fn)
      },
      async close() {
        await pool.end()
      },
    }
    rawByStore.set(store, { kind: 'postgres', db, pool })
    return store
  }

  throw new ConfigError(`Unsupported commandStore: ${String(config.infrastructure.commandStore)}`, {
    context: { commandStore: config.infrastructure.commandStore },
  })
}
