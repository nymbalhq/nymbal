import { checkStock, race, type StockViolation } from '@nymbalhq/proof-kit/race'
import Database from 'better-sqlite3'
import pg from 'pg'

// A fixture pair: a one-table inventory with a correct conditional decrement and a deliberately broken
// read-then-write one, on SQLite and on Postgres. The harness must pass the first and catch the second.

export interface Inventory {
  seed(id: string, qty: number): Promise<void>
  qty(id: string): Promise<number>
  /** `UPDATE … SET qty = qty - n WHERE id = $id AND qty >= n`; won when exactly one row changed. */
  decrementCorrect(id: string, n: number): Promise<void>
  /** Read qty; yield; reject if qty < n; write qty - n. Loses updates under concurrency, on purpose. */
  decrementBroken(id: string, n: number): Promise<void>
  close(): Promise<void>
}

/** The rejection of a decrement that found too little stock: the only reason a contender may lose. */
export class NotWon extends Error {
  constructor(id: string) {
    super(`not won: ${id}`)
    this.name = 'NotWon'
  }
}

/** One turn of the event loop, so every contender reads before any writes (a yield, not a sleep). */
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function sqliteInventory(file: string): Inventory {
  const db = new Database(file)
  db.exec('CREATE TABLE inventory (id TEXT PRIMARY KEY, qty INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO inventory (id, qty) VALUES (?, ?)')
  const read = db.prepare('SELECT qty FROM inventory WHERE id = ?')
  const conditional = db.prepare('UPDATE inventory SET qty = qty - @n WHERE id = @id AND qty >= @n')
  const write = db.prepare('UPDATE inventory SET qty = ? WHERE id = ?')
  const current = (id: string): number => (read.get(id) as { qty: number }).qty

  return {
    async seed(id, qty) {
      insert.run(id, qty)
    },
    async qty(id) {
      return current(id)
    },
    async decrementCorrect(id, n) {
      await yieldTurn()
      if (conditional.run({ id, n }).changes !== 1) throw new NotWon(id)
    },
    async decrementBroken(id, n) {
      const qty = current(id)
      await yieldTurn()
      if (qty < n) throw new NotWon(id)
      write.run(qty - n, id)
    },
    async close() {
      db.close()
    },
  }
}

const CONNECTIONS_GONE_TIMEOUT_MS = 10_000
const CONNECTIONS_POLL_MS = 25

/** Resolves once no backend is connected to `database`; throws, naming the count, if that takes too long. */
async function untilNoConnections(admin: pg.Pool, database: string): Promise<void> {
  const deadline = Date.now() + CONNECTIONS_GONE_TIMEOUT_MS
  for (;;) {
    const result = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [database],
    )
    const n = result.rows[0]!.n
    if (n === 0) return
    if (Date.now() > deadline) {
      throw new Error(
        `${database}: ${n} connection(s) still open ${CONNECTIONS_GONE_TIMEOUT_MS} ms after pool.end()`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, CONNECTIONS_POLL_MS))
  }
}

/** A fresh database on the server at `serverUrl`, dropped by `close()`. */
export async function postgresInventory(serverUrl: string): Promise<Inventory> {
  const database = `proof_kit_${process.pid}_${Date.now()}`
  const admin = new pg.Pool({ connectionString: serverUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${database}`)
  const url = new URL(serverUrl)
  url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 })
  await pool.query('CREATE TABLE inventory (id text PRIMARY KEY, qty integer NOT NULL)')

  const current = async (id: string): Promise<number> => {
    const result = await pool.query<{ qty: number }>('SELECT qty FROM inventory WHERE id = $1', [
      id,
    ])
    return result.rows[0]!.qty
  }

  return {
    async seed(id, qty) {
      await pool.query('INSERT INTO inventory (id, qty) VALUES ($1, $2)', [id, qty])
    },
    qty: current,
    async decrementCorrect(id, n) {
      const result = await pool.query(
        'UPDATE inventory SET qty = qty - $1 WHERE id = $2 AND qty >= $1',
        [n, id],
      )
      if (result.rowCount !== 1) throw new NotWon(id)
    },
    async decrementBroken(id, n) {
      const qty = await current(id)
      await yieldTurn()
      if (qty < n) throw new NotWon(id)
      await pool.query('UPDATE inventory SET qty = $1 WHERE id = $2', [qty - n, id])
    },
    async close() {
      await pool.end()
      // pool.end() resolves before each client's socket has closed; dropping now would terminate clients that are
      // still ending, and they would emit an unhandled error. Wait until the server has let go of every one.
      await untilNoConnections(admin, database)
      await admin.query(`DROP DATABASE IF EXISTS ${database}`)
      await admin.end()
    },
  }
}

export interface StockRun {
  contenders: number
  wins: number
  lost: number
  /** Losses for any reason but NotWon: a setup error, a driver error, never a valid loss. */
  unexpected: number
  initial: number
  final: number
  violations: StockViolation[]
}

/** `runs` consecutive races of `contenders` buyers for `units` units, one unit each, judged by `checkStock`. */
export async function stockRaceRuns(
  inventory: Inventory,
  decrement: 'decrementCorrect' | 'decrementBroken',
  opts: { runs: number; contenders: number; units: number },
): Promise<StockRun[]> {
  const out: StockRun[] = []
  for (let run = 0; run < opts.runs; run += 1) {
    const id = `${decrement}-${run}`
    await inventory.seed(id, opts.units)
    const outcome = await race(() => inventory[decrement](id, 1), {
      contenders: opts.contenders,
    })
    const final = await inventory.qty(id)
    out.push({
      contenders: opts.contenders,
      wins: outcome.won.length,
      lost: outcome.lost.length,
      unexpected: outcome.lost.filter((reason) => !(reason instanceof NotWon)).length,
      initial: opts.units,
      final,
      violations: checkStock({
        initial: opts.units,
        final,
        qtyPerWin: 1,
        wins: outcome.won.length,
      }),
    })
  }
  return out
}
