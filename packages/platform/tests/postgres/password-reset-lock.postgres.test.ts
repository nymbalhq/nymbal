import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKernel } from '../support/kernel.js'
import {
  customerRowOf,
  jtiOf,
  liveRefreshOf,
  neverIssued,
  openPasswordStore,
  registered,
  reset,
  RESET_TTL_MS,
  said,
  sha256,
  type PasswordStore,
} from '../support/password-reset.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'

// A reset and a password change on Postgres at READ COMMITTED, each while a transaction of the test's own holds the
// row it must change: the call under test is sent while that transaction is open and waits behind it (Postgres says
// so: pg_blocking_pids), and only the commit lets it answer. Nothing here waits on the clock.

const serverUrl = postgresServerUrl()
let db: TestDatabase
let s: PasswordStore

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'password_reset_lock')
  s = await openPasswordStore((opts) =>
    createKernel({ dialect: 'postgres', postgresUrl: db.url, ...opts }),
  )
}, 60_000)

afterAll(async () => {
  await s?.close()
  await db?.drop()
}, 60_000)

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
        const blocked = await s.raw.rows<{ pid: number }>(
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

describe('AC-13: a link consumed by another transaction is refused once it commits', () => {
  // Defect: single use is a read-then-delete, so a reset that read the row before another consumed it still succeeds.
  it('AC-13: with a transaction holding the row’s consumption uncommitted, a reset with the same token waits; after COMMIT it answers 400 auth.reset_link_invalid and the hash is as it was', async () => {
    const owner = await registered(s, 'ac13-lock')
    const token = neverIssued()
    await s.k.store.transaction((tx) =>
      s.k.repos.passwordResetToken.insert(tx, {
        id: uuidv7(),
        customerId: owner.customerId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        createdAt: new Date(),
      }),
    )
    const hashBefore = (await customerRowOf(s, owner.customerId)).password_hash

    const { held, answer } = await behindHolder(
      (holder) =>
        holder.query(
          'DELETE FROM password_reset_tokens WHERE token_hash = $1 RETURNING customer_id',
          [sha256(token)],
        ),
      () => reset(s, token, `ac13-lock-${randomUUID()}`),
    )

    expect(held.rowCount, 'the holder consumed the row').toBe(1)
    expect(said(answer)).toEqual([400, 'auth.reset_link_invalid'])
    expect((await customerRowOf(s, owner.customerId)).password_hash).toBe(hashBefore)
  }, 30_000)
})

describe('AC-20: a rotation held open is swept by the change once it commits', () => {
  // Defect: the change's revoke runs without the locked sweep, so the successor committed behind it stays live.
  it('AC-20: with a rotation R0 → R1 uncommitted, a password change waits; after COMMIT R1 is revoked and the change’s session is the only live one', async () => {
    const owner = await registered(s, 'ac20-lock')
    const r0 = jtiOf(owner.refreshToken)
    const r1 = { id: uuidv7(), tokenHash: randomUUID() }

    const { answer } = await behindHolder(
      async (holder) => {
        await holder.query(
          'UPDATE refresh_tokens SET replaced_by_jti = $1, revoked_at = COALESCE(revoked_at, now()) WHERE id = $2',
          [r1.id, r0],
        )
        await holder.query(
          `INSERT INTO refresh_tokens (id, customer_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, now() + interval '1 day', now())`,
          [r1.id, owner.customerId, r1.tokenHash],
        )
      },
      (): Promise<{ tokens: { refreshToken: string } }> =>
        s.k.services.auth.changePassword(
          owner.customerId,
          owner.password,
          `ac20-lock-${randomUUID()}`,
        ),
    )

    expect(await liveRefreshOf(s, owner.customerId)).toEqual([jtiOf(answer.tokens.refreshToken)])
  }, 30_000)
})
