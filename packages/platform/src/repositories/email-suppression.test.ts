import fc from 'fast-check'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import {
  createEmailSuppressionRepository,
  type EmailSuppressionInput,
  type EmailSuppressionRepository,
} from './email-suppression.js'

// A suppression holds an address however it is spelled, and each write answers whether this call changed a row: a
// repeat suppress and a clear of nothing both answer false.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  return { store, repo: createEmailSuppressionRepository(store) }
}

const AT = new Date('2026-10-01T10:00:00.000Z')
const input = (over: Partial<EmailSuppressionInput> = {}): EmailSuppressionInput => ({
  email: 'a@b.test',
  reason: 'hard_bounce',
  eventId: 'evt-1',
  at: AT,
  ...over,
})

describe('EmailSuppressionRepository on SQLite', () => {
  // Defect: the suppress or clear answer stops saying whether this call changed the row.
  it('suppress answers true once, and clear answers true once, for any spelling', async () => {
    const { store, repo } = await setup()
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (upper, padded) => {
        const spelled = `${padded ? '  ' : ''}${upper ? 'A@B.TEST' : 'a@b.test'}`

        const first = await store.transaction((tx) => repo.suppress(tx, input({ email: spelled })))
        const again = await store.transaction((tx) => repo.suppress(tx, input()))
        const held = await store.read((tx) => repo.isSuppressed(tx, spelled))
        const cleared = await store.transaction((tx) => repo.clear(tx, spelled))
        const clearedAgain = await store.transaction((tx) => repo.clear(tx, spelled))

        expect([first, again, held, cleared, clearedAgain]).toEqual([
          true,
          false,
          true,
          true,
          false,
        ])
      }),
      { numRuns: 20 },
    )
    await store.close()
  })
})

// The unit suites run on SQLite, so drizzle's real Postgres driver stands here against a connection that records what
// it is sent and answers with `answer`.
interface Sent {
  text: string
  values: unknown[]
}

async function withPostgres(
  answer: { rowCount?: number | null; rows?: unknown[][] },
  run: (repo: EmailSuppressionRepository, store: CommandStore) => Promise<void>,
): Promise<Sent[]> {
  const sent: Sent[] = []
  const connection = {
    query: async (statement: string | { text: string }, values?: unknown[]) => {
      if (typeof statement === 'string') return { command: statement, rows: [], rowCount: 0 }
      sent.push({ text: statement.text, values: values ?? [] })
      return { rows: answer.rows ?? [], rowCount: answer.rowCount }
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
    await run(createEmailSuppressionRepository(store), store)
  } finally {
    connect.mockRestore()
    await store.close()
  }
  return sent
}

const KEYED = '"email_suppressions"."email" = $1'

describe('EmailSuppressionRepository on Postgres', () => {
  // Defect: the insert loses its columns or its no-conflict clause, or the answer stops reflecting the row count.
  it.each([
    [1, true],
    [0, false],
    [null, false],
  ])(
    'suppress with rowCount %s answers %s and sends the normalised row',
    async (rowCount, want) => {
      let did: boolean | undefined

      const sent = await withPostgres({ rowCount }, (repo, store) =>
        store.transaction(async (tx) => {
          did = await repo.suppress(tx, input({ email: ' A@B.TEST ' }))
        }),
      )

      expect(did).toBe(want)
      expect(sent).toEqual([
        {
          text: 'insert into "email_suppressions" ("email", "reason", "event_id", "created_at") values ($1, $2, $3, $4) on conflict do nothing',
          values: ['a@b.test', 'hard_bounce', 'evt-1', AT.toISOString()],
        },
      ])
    },
  )

  // Defect: isSuppressed stops looking at the rows it is answered, or queries an unnormalised address.
  it.each([
    [[['a@b.test']], true],
    [[], false],
  ])('isSuppressed answered %j answers %s', async (rows, want) => {
    let held: boolean | undefined

    const sent = await withPostgres({ rows }, (repo, store) =>
      store.read(async (tx) => {
        held = await repo.isSuppressed(tx, ' A@B.TEST ')
      }),
    )

    expect(held).toBe(want)
    expect(sent).toEqual([
      {
        text: `select "email" from "email_suppressions" where ${KEYED} limit $2`,
        values: ['a@b.test', 1],
      },
    ])
  })

  // Defect: find runs the SQLite path on a Postgres handle, loses the reason or date, or a missing row is not null.
  it('find maps the row it is answered, and answers null for none', async () => {
    let found: unknown
    let absent: unknown = 'unset'

    const sent = await withPostgres(
      { rows: [['a@b.test', 'complaint', 'evt-1', AT.toISOString()]] },
      (repo, store) =>
        store.read(async (tx) => {
          found = await repo.find(tx, ' A@B.TEST ')
        }),
    )
    await withPostgres({ rows: [] }, (repo, store) =>
      store.read(async (tx) => {
        absent = await repo.find(tx, 'a@b.test')
      }),
    )

    expect(found).toEqual({ reason: 'complaint', createdAt: AT.toISOString() })
    expect(absent).toBeNull()
    expect(sent).toEqual([
      {
        text: `select "email", "reason", "event_id", "created_at" from "email_suppressions" where ${KEYED} limit $2`,
        values: ['a@b.test', 1],
      },
    ])
  })

  // Defect: the delete loses its key, or the answer stops reflecting the row count.
  it.each([
    [1, true],
    [0, false],
    [null, false],
  ])('clear with rowCount %s answers %s and deletes that address', async (rowCount, want) => {
    let did: boolean | undefined

    const sent = await withPostgres({ rowCount }, (repo, store) =>
      store.transaction(async (tx) => {
        did = await repo.clear(tx, ' A@B.TEST ')
      }),
    )

    expect(did).toBe(want)
    expect(sent).toEqual([
      { text: `delete from "email_suppressions" where ${KEYED}`, values: ['a@b.test'] },
    ])
  })
})
