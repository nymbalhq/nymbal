import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EVT_ORDER_PAID } from '@nymbalhq/types'
import { runUntilKilled } from '@nymbalhq/proof-kit/chaos'
import { createMailSink } from '@nymbalhq/proof-kit/mail'
import { startTestStore } from '@nymbalhq/proof-kit/store'
import type { Kernel } from '../../../platform/tests/support/kernel.js'
import { adminClient } from '../../../platform/tests/support/money.js'
import { eventRows } from '../../../platform/tests/support/outbox.js'
import { createDatabase } from '../../../platform/tests/support/postgres.js'
import { openRaw } from '../../../platform/tests/support/raw.js'

// AC-1 (SQLite) and AC-2 (Postgres): a child process runs a checkout, which the stub pays inline, with armChaos at
// order.paid.v1 and is SIGKILLed when that event reaches the bus, after its transaction committed. The events table
// holds the row, undelivered. A store restarted on the same database delivers it: one order-placed email in Mailpit
// (sent on order.paid) and the order served, confirmed: the parent never saw the checkout answer and holds no order
// key, so it reads the order as the admin does. A second restart sends nothing.
// The file refuses to load without NYMBAL_TEST_MAILPIT_URL and NYMBAL_TEST_POSTGRES_URL.

function required(name: string, example: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set: the proof-kit-services project needs it ` +
        `(pnpm gate:full starts the services with docker compose; e.g. ${name}=${example})`,
    )
  }
  return value
}

required('NYMBAL_TEST_MAILPIT_URL', 'http://localhost:18025')
const postgresServer = required(
  'NYMBAL_TEST_POSTGRES_URL',
  'postgres://postgres:nymbal@localhost:54329/nymbal',
)

const CHILD = fileURLToPath(new URL('../fixtures/outbox-kill-child.mjs', import.meta.url))

type Dialect = 'sqlite' | 'postgres'

interface Database {
  target: string
  drop(): Promise<void>
}

const cases: Array<{ ac: string; dialect: Dialect; fresh: () => Promise<Database> }> = [
  {
    ac: 'AC-1',
    dialect: 'sqlite',
    async fresh() {
      const dir = mkdtempSync(join(tmpdir(), 'outbox-kill-'))
      return {
        target: join(dir, 'store.sqlite'),
        async drop() {
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
  {
    ac: 'AC-2',
    dialect: 'postgres',
    async fresh() {
      const db = await createDatabase(postgresServer, 'outbox_kill')
      return { target: db.url, drop: () => db.drop() }
    },
  },
]

function restart(dialect: Dialect, target: string, sink: ReturnType<typeof createMailSink>) {
  return startTestStore(
    dialect === 'postgres'
      ? { commandStore: 'postgres', postgresUrl: target, email: sink }
      : { sqlitePath: target, email: sink },
  )
}

describe.each(cases)(
  '$ac: a kill between write and publish ($dialect)',
  ({ ac, dialect, fresh }) => {
    it(`${ac}: SIGKILL at order.paid.v1 leaves its events row undelivered; a restart delivers it (exactly one order-placed email, the order served by GET /api/admin/orders/:orderNumber, confirmed); a second restart leaves the email count at 1 (${dialect})`, async () => {
      const sink = createMailSink()
      const buyer = `${ac.toLowerCase()}-${randomUUID()}@proof-kit.test`
      const db = await fresh()
      try {
        const run = await runUntilKilled({
          script: CHILD,
          args: [dialect, db.target, buyer],
          point: { beforePublish: EVT_ORDER_PAID },
          timeoutMs: 60_000,
        })
        expect(
          { killed: run.killed, signal: run.signal, timedOut: run.timedOut },
          `${run.stdout}\n${run.stderr}`,
        ).toEqual({ killed: true, signal: 'SIGKILL', timedOut: false })

        const raw = openRaw(dialect, db.target)
        try {
          const before = await eventRows(raw)
          const paid = before.filter((r) => r.type === EVT_ORDER_PAID)
          expect(
            paid.map((r) => ({ delivered: r.deliveredAt ?? null, dead: r.deadAt ?? null })),
            'order.paid.v1 rows before the restart',
          ).toEqual([{ delivered: null, dead: null }])
          const order = await raw.one<{ id: string; order_number: string }>(
            'SELECT id, order_number FROM orders',
          )

          const first = await restart(dialect, db.target, sink)
          try {
            await sink.waitFor({ to: buyer, count: 1 }, { timeoutMs: 10_000 })
            const mails = await sink.messages({ to: buyer })
            expect(mails.length, 'order-placed emails after the first restart').toBe(1)
            expect(mails[0]!.subject).toContain(order.order_number)

            const admin = await adminClient(
              {
                store: first.app.platform.commandStore,
                repos: first.app.repos,
              } satisfies Pick<Kernel, 'store' | 'repos'> as Kernel,
              first.baseUrl,
            )
            const res = await admin.call<{ id: string; status: string }>(
              'GET',
              `/api/admin/orders/${order.order_number}`,
            )
            expect(res.status, JSON.stringify(res.body)).toBe(200)
            expect(res.body.data?.id).toBe(order.id)
            expect(res.body.data?.status).toBe('confirmed')

            // Every row the kill left behind, delivered or not, is delivered now; the restart appended none.
            const after = await eventRows(raw)
            expect(after.filter((r) => r.deliveredAt != null).map((r) => r.id)).toEqual(
              before.map((r) => r.id),
            )
          } finally {
            await first.stop()
          }

          const second = await restart(dialect, db.target, sink)
          try {
            expect(
              (await sink.messages({ to: buyer })).length,
              'order-placed emails after the second restart',
            ).toBe(1)
          } finally {
            await second.stop()
          }
        } finally {
          await raw.close()
        }
      } finally {
        await db.drop()
      }
    }, 120_000)
  },
)
