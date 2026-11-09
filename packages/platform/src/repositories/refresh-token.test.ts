import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { RefreshTokenInsert, RefreshTokenRepository } from './refresh-token.js'

// Removing an imported customer ends that customer's sessions and nobody else's. Rotation is a conditional write whose
// boolean the auth service acts on, and revoke-all ends rotated rows too.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  return { store, repo: repos.refreshToken }
}
type Env = Awaited<ReturnType<typeof setup>>

function token(customerId: string): RefreshTokenInsert {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 10, 0, 0))
  return {
    id: uuidv7(),
    customerId,
    tokenHash: uuidv7(),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 86_400_000),
  }
}

const rows = (env: Env, tokens: RefreshTokenInsert[]) =>
  env.store.read(async (tx) => {
    const out = []
    for (const t of tokens) out.push(await env.repo.findById(tx, t.id))
    return out
  })

describe('RefreshTokenRepository: removal by customer', () => {
  // Defect: the delete loses its customer condition (rolling one imported customer back signs every customer out) or
  // deletes nothing (the removed customer's tokens stay behind).
  it('deleteByCustomer removes the tokens of that customer and leaves every other customer’s as they were', async () => {
    const env = await setup()
    const [gone, kept] = [uuidv7(), uuidv7()]
    const goneTokens = [token(gone), token(gone)]
    const keptTokens = [token(kept), token(kept)]
    await env.store.transaction(async (tx) => {
      for (const t of [...goneTokens, ...keptTokens]) await env.repo.insert(tx, t)
    })
    // One of the kept customer's tokens revoked, so "as they were" covers a row that is not fresh.
    await env.store.transaction((tx) => env.repo.revoke(tx, keptTokens[0]!.id))
    const keptBefore = await rows(env, keptTokens)

    await env.store.transaction((tx) => env.repo.deleteByCustomer(tx, gone))

    expect(await rows(env, goneTokens)).toEqual(goneTokens.map(() => null))
    expect(await rows(env, keptTokens)).toEqual(keptBefore)
    await env.store.close()
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const FIRST = new Date('2026-10-01T10:00:00.000Z')
const LATER = new Date('2026-10-01T10:00:20.000Z')

const insertAll = (env: Env, tokens: RefreshTokenInsert[]) =>
  env.store.transaction(async (tx) => {
    for (const t of tokens) await env.repo.insert(tx, t)
  })

const rotate = (env: Env, old: RefreshTokenInsert, next: RefreshTokenInsert) =>
  env.store.transaction((tx) => env.repo.rotate(tx, old.id, next))

describe('RefreshTokenRepository: rotate', () => {
  // Defect: the guard on `changes` goes, or answers true: a token signed out while its refresh was in flight gets a
  // live successor.
  it('refuses a row revoked with no successor: false, the row as it was, no successor written', async () => {
    const env = await setup()
    const old = token('customer-a')
    const next = token('customer-a')
    await insertAll(env, [old])
    await env.store.transaction((tx) => env.repo.revoke(tx, old.id))
    const before = await rows(env, [old])

    expect(await rotate(env, old, next)).toBe(false)

    expect(await rows(env, [old])).toEqual(before)
    expect(await rows(env, [next])).toEqual([null])
    await env.store.close()
  })

  // Defect: same guard, for a row that is gone (purged between the read and the write).
  it('refuses a row that does not exist and writes no successor', async () => {
    const env = await setup()
    const next = token('customer-a')

    expect(await rotate(env, token('customer-a'), next)).toBe(false)

    expect(await rows(env, [next])).toEqual([null])
    await env.store.close()
  })

  // Defect: re-rotating stamps `revokedAt` again, so the reuse window slides with every refresh of the old token.
  it('rotates a live row, then a rotated one, keeping the instant of the first rotation', async () => {
    const env = await setup()
    const [old, first, second] = [token('c'), token('c'), token('c')]
    await insertAll(env, [old])
    vi.useFakeTimers({ toFake: ['Date'], now: FIRST })

    expect(await rotate(env, old, first)).toBe(true)
    vi.setSystemTime(LATER)
    expect(await rotate(env, old, second)).toBe(true)

    const [row, firstRow, secondRow] = await rows(env, [old, first, second])
    expect(row).toMatchObject({ revokedAt: FIRST.toISOString(), replacedByJti: second.id })
    expect(firstRow?.revokedAt).toBeNull()
    expect(secondRow?.customerId).toBe('c')
    await env.store.close()
  })
})

describe('RefreshTokenRepository: revoke', () => {
  // Defect: the answer stops tracking `changes`, so logout of an already rotated token stops ending every session.
  it('answers true for the call that revoked a live row and false for a revoked, rotated or absent one', async () => {
    const env = await setup()
    const [live, rotated, successor] = [token('c'), token('c'), token('c')]
    await insertAll(env, [live, rotated])
    await rotate(env, rotated, successor)
    const rotatedBefore = await rows(env, [rotated])
    const revoke = (id: string) => env.store.transaction((tx) => env.repo.revoke(tx, id))

    expect(await revoke(live.id)).toBe(true)
    expect(await revoke(live.id)).toBe(false)
    expect(await revoke(rotated.id)).toBe(false)
    expect(await revoke(uuidv7())).toBe(false)

    expect(await rows(env, [rotated])).toEqual(rotatedBefore)
    await env.store.close()
  })
})

describe('RefreshTokenRepository: revokeAllForCustomer', () => {
  // Defect: the predicate stops at live rows (a rotated row can be rotated again inside the window), matches other
  // customers, or overwrites `revokedAt`; or the pointer is left set, which reopens the reuse window.
  it('ends live and rotated rows of the customer, keeps earlier instants and leaves other customers as they were', async () => {
    const env = await setup()
    const [live, rotated, successor, signedOut] = [token('c'), token('c'), token('c'), token('c')]
    const other = token('other')
    await insertAll(env, [live, rotated, signedOut, other])
    vi.useFakeTimers({ toFake: ['Date'], now: FIRST })
    await rotate(env, rotated, successor)
    await env.store.transaction((tx) => env.repo.revoke(tx, signedOut.id))
    const otherBefore = await rows(env, [other])
    vi.setSystemTime(LATER)

    await env.store.transaction((tx) => env.repo.revokeAllForCustomer(tx, 'c'))

    const [liveRow, rotatedRow, successorRow, signedOutRow] = await rows(env, [
      live,
      rotated,
      successor,
      signedOut,
    ])
    expect(liveRow).toMatchObject({ revokedAt: LATER.toISOString(), replacedByJti: null })
    expect(rotatedRow).toMatchObject({ revokedAt: FIRST.toISOString(), replacedByJti: null })
    expect(successorRow).toMatchObject({ revokedAt: LATER.toISOString(), replacedByJti: null })
    expect(signedOutRow).toMatchObject({ revokedAt: FIRST.toISOString(), replacedByJti: null })
    expect(await rows(env, [other])).toEqual(otherBefore)
    expect(await rotate(env, rotated, token('c'))).toBe(false)
    await env.store.close()
  })
})

// The unit suites run on SQLite, so drizzle's real Postgres driver stands here against a connection that records what
// it is sent and answers with `answer`. Against a real server these statements are exercised by the Postgres suite;
// here each dialect branch is held to the statement it must send and the answer it must return.
interface Sent {
  text: string
  values: unknown[]
}

async function withPostgres(
  answer: { rowCount?: number | null; rows?: unknown[][] },
  run: (repo: RefreshTokenRepository, store: CommandStore) => Promise<void>,
): Promise<Sent[]> {
  const sent: Sent[] = []
  const connection = {
    query: async (statement: string | { text: string }, values?: unknown[]) => {
      if (typeof statement === 'string') return { command: statement, rows: [], rowCount: 0 }
      sent.push({ text: statement.text, values: values ?? [] })
      return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? 0 }
    },
    release: () => undefined,
  }
  const connect = vi
    .spyOn(pg.Pool.prototype, 'connect')
    .mockImplementation(async () => connection as never)
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
    { postgresUrl: 'postgres://unused/none' },
  )
  try {
    await run(
      buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })).refreshToken,
      store,
    )
  } finally {
    connect.mockRestore()
    await store.close()
  }
  return sent
}

const TABLE = '"refresh_tokens"'
const ROTATABLE = `(${TABLE}."revoked_at" is null or ${TABLE}."replaced_by_jti" is not null)`
const INSERT = `insert into ${TABLE} ("id", "customer_id", "token_hash", "revoked_at", "replaced_by_jti", "expires_at", "created_at") values ($1, $2, $3, $4, $5, $6, $7)`
const ROTATE = `update ${TABLE} set "revoked_at" = COALESCE(${TABLE}."revoked_at", $1), "replaced_by_jti" = $2 where (${TABLE}."id" = $3 and ${ROTATABLE})`

const insertedValues = (t: RefreshTokenInsert) => [
  t.id,
  t.customerId,
  t.tokenHash,
  null,
  null,
  t.expiresAt.toISOString(),
  t.createdAt.toISOString(),
]

describe('RefreshTokenRepository on Postgres', () => {
  // Defect: the insert loses its columns, or the branch runs the SQLite path on a Postgres handle.
  it('insert writes every column of a live row', async () => {
    const t = token('c')

    const sent = await withPostgres({ rowCount: 1 }, (repo, store) =>
      store.transaction((tx) => repo.insert(tx, t)),
    )

    expect(sent).toEqual([{ text: INSERT, values: insertedValues(t) }])
  })

  // Defect: a row read back on Postgres comes through the wrong dialect, or an absent row is not null.
  it('findById maps the row it is answered and answers null for none', async () => {
    const t = token('c')
    const row = [
      t.id,
      'c',
      t.tokenHash,
      null,
      null,
      t.expiresAt.toISOString(),
      t.createdAt.toISOString(),
    ]
    let found: unknown
    let absent: unknown

    await withPostgres({ rows: [row] }, (repo, store) =>
      store.read(async (tx) => {
        found = await repo.findById(tx, t.id)
      }),
    )
    await withPostgres({ rows: [] }, (repo, store) =>
      store.read(async (tx) => {
        absent = await repo.findById(tx, t.id)
      }),
    )

    expect(found).toEqual({
      id: t.id,
      customerId: 'c',
      tokenHash: t.tokenHash,
      revokedAt: null,
      replacedByJti: null,
      expiresAt: t.expiresAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
    })
    expect(absent).toBeNull()
  })

  // Defect: the update loses the first-rotation COALESCE or the rotatable predicate, the successor loses its columns,
  // or the answer stops being true once both writes ran.
  it('rotate of a changed row sends the conditional update, then the successor, and answers true', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: LATER })
    const next = token('c')
    let did: boolean | undefined

    const sent = await withPostgres({ rowCount: 1 }, (repo, store) =>
      store.transaction(async (tx) => {
        did = await repo.rotate(tx, 'old-jti', next)
      }),
    )

    expect(did).toBe(true)
    expect(sent).toEqual([
      { text: ROTATE, values: [LATER, next.id, 'old-jti'] },
      { text: INSERT, values: insertedValues(next) },
    ])
  })

  // Defect: the refusal goes or answers true: a signed-out token's refresh writes a live successor on Postgres.
  it('rotate of no changed row answers false and writes no successor', async () => {
    const next = token('c')
    let did: boolean | undefined

    const sent = await withPostgres({ rowCount: 0 }, (repo, store) =>
      store.transaction(async (tx) => {
        did = await repo.rotate(tx, 'old-jti', next)
      }),
    )

    expect(did).toBe(false)
    expect(sent.map((s) => s.text)).toEqual([ROTATE])
  })

  // Defect: the update drops `revoked_at`, or the answer stops tracking `rowCount`.
  it('revoke stamps a live row and answers whether it changed one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: LATER })
    const revoke = async (rowCount: number) => {
      let did: boolean | undefined
      const sent = await withPostgres({ rowCount }, (repo, store) =>
        store.transaction(async (tx) => {
          did = await repo.revoke(tx, 'jti')
        }),
      )
      return { did, sent }
    }

    const changed = await revoke(1)
    const unchanged = await revoke(0)

    expect(changed.did).toBe(true)
    expect(changed.sent).toEqual([
      {
        text: `update ${TABLE} set "revoked_at" = $1 where (${TABLE}."id" = $2 and ${TABLE}."revoked_at" is null)`,
        values: [LATER.toISOString(), 'jti'],
      },
    ])
    expect(unchanged.did).toBe(false)
  })

  // Defect: the lock is dropped or weakened, so a rotation in flight commits a successor the update's snapshot never
  // saw; or the update loses COALESCE or the pointer clear.
  it('revokeAllForCustomer locks the rows, then ends them keeping earlier instants and clearing the pointer', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: LATER })
    const ofCustomer = `(${TABLE}."customer_id" = $1 and ${ROTATABLE})`

    const sent = await withPostgres({ rowCount: 2 }, (repo, store) =>
      store.transaction((tx) => repo.revokeAllForCustomer(tx, 'c')),
    )

    expect(sent).toEqual([
      {
        text: `select "id" from ${TABLE} where ${ofCustomer} order by ${TABLE}."id" for update`,
        values: ['c'],
      },
      {
        text: `update ${TABLE} set "revoked_at" = COALESCE(${TABLE}."revoked_at", $1), "replaced_by_jti" = $2 where (${TABLE}."customer_id" = $3 and ${ROTATABLE})`,
        values: [LATER, null, 'c'],
      },
    ])
  })

  // Defect: the driver's count is lost, so the sweeper logs nothing deleted; or a predicate targets the wrong rows.
  it('purgeExpired and purgeRotated answer the driver count and send their predicates', async () => {
    const cutoff = new Date('2026-10-01T00:00:00.000Z')
    let expired: number | undefined
    let rotated: number | undefined

    const sent = await withPostgres({ rowCount: 3 }, (repo, store) =>
      store.transaction(async (tx) => {
        expired = await repo.purgeExpired(tx, cutoff)
        rotated = await repo.purgeRotated(tx, cutoff)
      }),
    )

    expect([expired, rotated]).toEqual([3, 3])
    expect(sent).toEqual([
      {
        text: `delete from ${TABLE} where ${TABLE}."expires_at" < $1`,
        values: [cutoff.toISOString()],
      },
      {
        text: `delete from ${TABLE} where (${TABLE}."replaced_by_jti" is not null and ${TABLE}."revoked_at" < $1)`,
        values: [cutoff.toISOString()],
      },
    ])
  })

  // Defect: the branch runs the SQLite path on a Postgres handle, or the delete loses its customer condition.
  it('deleteByCustomer deletes only that customer', async () => {
    const sent = await withPostgres({ rowCount: 1 }, (repo, store) =>
      store.transaction((tx) => repo.deleteByCustomer(tx, 'c')),
    )

    expect(sent).toEqual([
      { text: `delete from ${TABLE} where ${TABLE}."customer_id" = $1`, values: ['c'] },
    ])
  })
})
