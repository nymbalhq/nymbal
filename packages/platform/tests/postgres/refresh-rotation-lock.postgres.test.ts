import pg from 'pg'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import type { RefreshTokenInsert } from '../../src/repositories/refresh-token.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'
import { openRaw, type RawReader } from '../support/raw.js'

// Rotation, revoke and revoke-all on Postgres at READ COMMITTED, each while a transaction of the test's own holds the
// row: the call under test is sent while that transaction is open and waits behind it (Postgres says so:
// pg_blocking_pids), and only the commit lets it answer. Nothing here waits on the clock.

const serverUrl = postgresServerUrl()
const DAY_MS = 86_400_000

let db: TestDatabase
let store: CommandStore
let repos: Repositories
let raw: RawReader

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'refresh_rotation_lock')
  store = createCommandStore(kernelConfig('postgres'), { postgresUrl: db.url })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  raw = openRaw('postgres', db.url)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await store?.close()
  await db?.drop()
}, 60_000)

function tokenOf(customerId: string): RefreshTokenInsert {
  const createdAt = new Date()
  return {
    id: uuidv7(),
    customerId,
    tokenHash: uuidv7(),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + DAY_MS),
  }
}

interface TokenRow {
  id: string
  revoked_at: string | null
  replaced_by_jti: string | null
}

async function liveSeeded(customerId: string): Promise<RefreshTokenInsert> {
  const token = tokenOf(customerId)
  await store.transaction((tx) => repos.refreshToken.insert(tx, token))
  return token
}

const rowsOf = (customerId: string): Promise<TokenRow[]> =>
  raw.rows<TokenRow>(
    `SELECT id, revoked_at::text AS revoked_at, replaced_by_jti FROM refresh_tokens
      WHERE customer_id = ? ORDER BY id`,
    [customerId],
  )

const rowOf = (id: string): Promise<TokenRow> =>
  raw.one<TokenRow>(
    'SELECT id, revoked_at::text AS revoked_at, replaced_by_jti FROM refresh_tokens WHERE id = ?',
    [id],
  )

const liveOf = async (customerId: string): Promise<string[]> =>
  (await rowsOf(customerId)).filter((row) => row.revoked_at === null).map((row) => row.id)

/** A rotation written by hand in the holder's transaction; returns the `revoked_at` it gave the old row. */
async function holdRotation(
  holder: pg.Client,
  oldJti: string,
  next: RefreshTokenInsert,
): Promise<string> {
  const { rows } = await holder.query<{ revoked_at: string }>(
    `UPDATE refresh_tokens SET replaced_by_jti = $1, revoked_at = COALESCE(revoked_at, now())
      WHERE id = $2 RETURNING revoked_at::text AS revoked_at`,
    [next.id, oldJti],
  )
  await holder.query(
    `INSERT INTO refresh_tokens (id, customer_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [next.id, next.customerId, next.tokenHash, next.expiresAt, next.createdAt],
  )
  return rows[0]!.revoked_at
}

/**
 * Opens a transaction, runs `hold` in it, sends `call`, and commits only once Postgres reports `call`'s backend blocked
 * on the holder and `call` has not answered. Returns what `call` answered after the commit.
 */
async function behindHolder<H, R>(
  hold: (holder: pg.Client) => Promise<H>,
  call: () => Promise<R>,
): Promise<{ held: H; answer: R }> {
  const holder = new pg.Client({ connectionString: db.url })
  await holder.connect()
  let settled = false
  let committed = false
  let answer: Promise<R> | undefined
  let held: H | undefined
  try {
    await holder.query('BEGIN')
    held = await hold(holder)
    const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const holderPid = rows[0]!.pid

    answer = call().finally(() => {
      settled = true
    })

    await vi.waitFor(
      async () => {
        const blocked = await raw.rows<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[?::int]',
          [holderPid],
        )
        expect(blocked.length, 'a backend is blocked on the held row').toBe(1)
      },
      { timeout: 15_000, interval: 20 },
    )
    expect(settled, 'the call has not answered while the transaction is open').toBe(false)

    await holder.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await holder.query('ROLLBACK').catch(() => undefined)
    await holder.end()
  }
  return { held: held as H, answer: await answer! }
}

describe('refresh rotation waits for, and re-checks, the write holding its row', () => {
  // Defect: UPDATE alone: it waits on R0 and re-checks only R0, and R1 was never in its snapshot, so R1 stays live.
  it('AC-7: with a rotation R0 → R1 uncommitted, revokeAllForCustomer waits; after COMMIT, R1 is revoked and R0’s pointer is null', async () => {
    const customerId = uuidv7()
    const r0 = await liveSeeded(customerId)
    const r1 = tokenOf(customerId)

    await behindHolder(
      (holder) => holdRotation(holder, r0.id, r1),
      () => store.transaction((tx) => repos.refreshToken.revokeAllForCustomer(tx, customerId)),
    )

    expect(await liveOf(customerId), 'neither R0 nor R1 is live').toEqual([])
    expect((await rowOf(r0.id)).replaced_by_jti).toBeNull()
  }, 30_000)

  // Defect: the decision is taken from a read instead of the row the UPDATE re-checks, so a rotation behind a sign-out
  // writes its successor anyway.
  it.each([
    {
      label: 'a revoke of R0',
      hold: (holder: pg.Client, id: string) =>
        holder.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [id]),
    },
    {
      label: 'a revoke-all of its customer',
      hold: (holder: pg.Client, _id: string, customerId: string) =>
        holder.query(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()), replaced_by_jti = NULL
            WHERE customer_id = $1`,
          [customerId],
        ),
    },
  ])(
    'AC-8: with $label uncommitted, rotate(R0) waits; after COMMIT it returns false and adds no row',
    async ({ hold }) => {
      const customerId = uuidv7()
      const r0 = await liveSeeded(customerId)
      const rowsBefore = (await rowsOf(customerId)).length

      const { answer } = await behindHolder(
        (holder) => hold(holder, r0.id, customerId),
        () => store.transaction((tx) => repos.refreshToken.rotate(tx, r0.id, tokenOf(customerId))),
      )

      expect(answer).toBe(false)
      expect((await rowsOf(customerId)).length, 'no row added').toBe(rowsBefore)
    },
    30_000,
  )

  // Defect: the predicate refuses a rotated row: two tabs on Postgres lose a session; or the waiter's clock replaces
  // the holder's revoked_at and the window slides.
  it('AC-9: with a rotation R0 → R1 uncommitted, rotate(R0 → R1′) waits; after COMMIT it returns true, revokedAt is the holder’s, and R1 and R1′ are both live', async () => {
    const customerId = uuidv7()
    const r0 = await liveSeeded(customerId)
    const r1 = tokenOf(customerId)
    const r1Prime = tokenOf(customerId)

    const { held: heldRevokedAt, answer } = await behindHolder(
      (holder) => holdRotation(holder, r0.id, r1),
      () => store.transaction((tx) => repos.refreshToken.rotate(tx, r0.id, r1Prime)),
    )

    expect(answer).toBe(true)
    expect((await rowOf(r0.id)).revoked_at, 'the holder’s instant').toBe(heldRevokedAt)
    expect((await liveOf(customerId)).sort()).toEqual([r1.id, r1Prime.id].sort())
  }, 30_000)
})
