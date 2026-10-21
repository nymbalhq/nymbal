import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, runCli } from '../../../../tests/support/doctor.js'
import { parseLine, sqliteProject, stdoutLines } from '../../../../tests/support/events-cli.js'
import { serveKernel } from '../../../platform/tests/support/http.js'
import { address, createKernel, seedVariant } from '../../../platform/tests/support/kernel.js'
import { stubPaymentWebhook } from '../../../platform/tests/support/proof-kit.js'
import { shopper } from '../../../platform/tests/support/shopper.js'

// Acceptance tests for P3-01 AC-6 (spec P3-01-event-log-surface, decision 7): `nymbal events query`, the built CLI
// spawned against a SQLite store holding one completed checkout plus noise (a second, unpaid checkout and a cart add,
// each under an id of its own). The store is made by a kernel from `src/` served over HTTP, then closed and switched to
// a rollback journal, so a command that writes leaves a trace (a `-wal`/`-shm` file, or changed bytes). The expected
// rows are read from the file by a second connection. Needs `pnpm build`. The platform half of AC-6 (append through
// the read-only opener rejects) is packages/platform/tests/support/suites/event-log-correlation.ts.
// Kills: the wrong order or filter, a payload printed by default, a command that writes, and an error that exits 0.

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => {
  prepare(sql: string): { all(): unknown[] }
  pragma(sql: string): unknown
  close(): void
}

interface StoredRow {
  seq: number
  id: string
  type: string
  envelope: Record<string, unknown> & { correlationId: string; payload: unknown }
  deliveredAt: string | null
}

const dirs: string[] = []
let dbPath: string
let project: { dir: string; env: NodeJS.ProcessEnv }
let rows: StoredRow[]
const checkoutId = `checkout.ac6:${randomUUID()}`
let orderId: string

const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function storedRows(): StoredRow[] {
  const db = new BetterSqlite3(dbPath, { readonly: true })
  try {
    const all = db
      .prepare('SELECT seq, id, type, envelope, delivered_at FROM events ORDER BY seq')
      .all() as Array<{
      seq: number
      id: string
      type: string
      envelope: string
      delivered_at: string | null
    }>
    return all.map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      type: r.type,
      envelope: JSON.parse(r.envelope) as StoredRow['envelope'],
      deliveredAt: r.delivered_at,
    }))
  } finally {
    db.close()
  }
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p3-01-query-'))
  dirs.push(dir)
  dbPath = join(dir, 'nymbal.db')
  const kernel = await createKernel({ dialect: 'sqlite', sqlitePath: dbPath })
  const served = await serveKernel(kernel)
  try {
    const seeded = await seedVariant(kernel, 100)
    const checkout = async (correlationId: string, pay: boolean) => {
      const s = shopper(served.baseUrl)
      const headers = { 'x-correlation-id': correlationId }
      expect((await s.call('GET', '/api/cart', undefined, { headers })).status).toBe(200)
      const added = await s.call(
        'POST',
        '/api/cart/items',
        { variantId: seeded.variantId, qty: 2 },
        { headers },
      )
      expect(added.status, JSON.stringify(added.body)).toBe(200)
      const placed = await s.call<{
        orderId: string
        paymentIntent: { id: string }
        totalMinor: number
        currency: string
      }>(
        'POST',
        '/api/checkout',
        {
          email: `ac6-${randomUUID()}+stub-pending@p3-01.test`,
          billingAddress: address,
          shippingAddress: address,
        },
        { headers },
      )
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const data = placed.body.data!
      if (pay) {
        const hook = stubPaymentWebhook({
          paymentIntentId: data.paymentIntent.id,
          amountMinor: data.totalMinor,
          currency: data.currency,
        })
        const res = await fetch(new URL(hook.path, served.baseUrl), {
          method: hook.method,
          headers: hook.headers,
          body: hook.body,
        })
        expect(res.status, await res.text()).toBe(200)
      }
      return data.orderId
    }
    await checkout(`noise.before:${randomUUID()}`, false)
    orderId = await checkout(checkoutId, true)
    const s = shopper(served.baseUrl)
    await s.call('GET', '/api/cart')
    await s.call(
      'POST',
      '/api/cart/items',
      { variantId: seeded.variantId, qty: 1 },
      { headers: { 'x-correlation-id': `noise.after:${randomUUID()}` } },
    )
  } finally {
    await served.stop()
  }
  // A rollback journal: any write the command makes changes the file's bytes or leaves a -wal/-shm beside it.
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = DELETE')
  db.close()
  rows = storedRows()
  project = sqliteProject(dbPath)
  dirs.push(project.dir)
}, 90_000)

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const subject = () => rows.filter((r) => r.envelope.correlationId === checkoutId)

function query(args: string[]) {
  return runCli(['events', 'query', ...args], { cwd: project.dir, env: project.env })
}

describe('P3-01 AC-6: nymbal events query', () => {
  it('AC-6: --correlation <the checkout’s id> prints exactly that checkout’s events, one line each, in seq order, and exits 0', async () => {
    const run = await query(['--correlation', checkoutId])
    expect(run.code, run.out.slice(-3000)).toBe(0)
    const expected = subject()
    expect(
      expected.some((r) => r.type === 'order.placed.v1') &&
        expected.some(
          (r) =>
            r.type === 'order.paid.v1' &&
            (r.envelope.payload as { orderId?: string }).orderId === orderId,
        ),
      'the fixture: the checkout’s id is on its order.placed and order.paid',
    ).toBe(true)

    const lines = stdoutLines(run.stdout)
    const parsed = lines.map(parseLine)
    expect(
      parsed.map(
        (l) => l && { seq: l.seq, type: l.type, correlationId: l.correlationId, id: l.id },
      ),
    ).toEqual(
      expected.map((r) => ({ seq: r.seq, type: r.type, correlationId: checkoutId, id: r.id })),
    )
    for (const l of parsed) expect(Number.isNaN(Date.parse(l!.timestamp)), l!.timestamp).toBe(false)
  })

  it('AC-6: --json prints one stored envelope per line, with seq and deliveredAt and without payload; --payload adds the payload', async () => {
    const plain = await query(['--correlation', checkoutId, '--json'])
    const withPayload = await query(['--correlation', checkoutId, '--json', '--payload'])
    expect([plain.code, withPayload.code], plain.out.slice(-2000)).toEqual([0, 0])
    const expected = subject()
    const parse = (stdout: string) =>
      stdoutLines(stdout).map((l) => JSON.parse(l) as Record<string, unknown>)

    const lines = parse(plain.stdout)
    expect(lines.length).toBe(expected.length)
    lines.forEach((line, i) => {
      const row = expected[i]!
      const { seq, deliveredAt, ...envelope } = line
      const { payload: _payload, ...stored } = row.envelope
      expect('payload' in line, 'payload printed without --payload').toBe(false)
      expect(envelope).toEqual(stored)
      expect(seq).toBe(row.seq)
      expect(deliveredAt === null ? null : new Date(String(deliveredAt)).getTime()).toBe(
        row.deliveredAt === null ? null : new Date(row.deliveredAt).getTime(),
      )
    })
    expect(parse(withPayload.stdout).map((l) => l['payload'])).toEqual(
      expected.map((r) => r.envelope.payload),
    )
  })

  it("AC-6: --type 'order.*' prints only the checkout's order.… events", async () => {
    const run = await query(['--correlation', checkoutId, '--type', 'order.*'])
    expect(run.code, run.out.slice(-3000)).toBe(0)
    const expected = subject().filter((r) => r.type.startsWith('order.'))
    expect(expected.length).toBeGreaterThan(0)
    expect(stdoutLines(run.stdout).map((l) => parseLine(l)?.id)).toEqual(expected.map((r) => r.id))
  })

  it('AC-6: an unknown id prints nothing and exits 0', async () => {
    const run = await query(['--correlation', `unknown:${randomUUID()}`])
    expect(run.code, run.out.slice(-3000)).toBe(0)
    expect(stdoutLines(run.stdout)).toEqual([])
  })

  it('AC-6: a missing store exits 2 with a message, and creates no file', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'p3-01-missing-')), 'absent.db')
    dirs.push(join(missing, '..'))
    const elsewhere = sqliteProject(missing)
    dirs.push(elsewhere.dir)
    const run = await runCli(['events', 'query', '--correlation', checkoutId], {
      cwd: elsewhere.dir,
      env: elsewhere.env,
    })
    expect(run.code, run.out.slice(-3000)).toBe(2)
    expect(run.stderr.trim().length, 'a message on stderr').toBeGreaterThan(0)
    expect(existsSync(missing), 'the query created the database').toBe(false)
  })

  it('AC-6: a bad --since exits 2 with a message naming it', async () => {
    const run = await query(['--correlation', checkoutId, '--since', 'not-a-time'])
    expect(run.code, run.out.slice(-3000)).toBe(2)
    expect(run.stderr.includes('since'), run.stderr).toBe(true)
  })

  it('AC-6: on a rollback-journal file, after events query no -wal or -shm file appears and the file’s bytes are unchanged', async () => {
    const before = hashOf(dbPath)
    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([false, false])
    const run = await query(['--correlation', checkoutId, '--json', '--payload'])
    expect(run.code, run.out.slice(-3000)).toBe(0)
    expect(stdoutLines(run.stdout).length, 'the query read the log').toBe(subject().length)

    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([false, false])
    expect(hashOf(dbPath)).toBe(before)
  })
})
