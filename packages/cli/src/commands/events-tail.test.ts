import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalEvent } from '@nymbalhq/types'
import { sqliteProject, startTail, type Tail } from '../../../../tests/support/events-cli.js'
import { createCommandStore, type CommandStore } from '../../../platform/src/db/command-store.js'
import { runMigrations } from '../../../platform/src/db/migrate.js'
import { InMemoryDocumentStore } from '../../../platform/src/document-store/in-memory.js'
import { createEventBuilder } from '../../../platform/src/events/builder.js'
import { buildRepositories, type Repositories } from '../../../platform/src/repositories/index.js'
import { TEST_BUILDER_CONTEXT } from '../../../platform/src/tests/publisher.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../../../platform/tests/support/kernel.js'

// AC-7: `nymbal events tail` on a running SQLite store this process appends to, one append per poll, with no
// duplicates or gaps and a clean exit on SIGINT. Needs `pnpm build`.

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

let dir: string
let dbPath: string
let store: CommandStore
let repos: Repositories
let project: { dir: string; env: NodeJS.ProcessEnv }
const tails: Tail[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'events-tail-'))
  dbPath = join(dir, 'nymbal.db')
  store = createCommandStore(kernelConfig('sqlite'), { sqlitePath: dbPath })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  await append(['history.one.v1', 'history.two.v1', 'history.three.v1', 'history.four.v1'])
  project = sqliteProject(dbPath)
})

afterEach(async () => {
  for (const tail of tails.splice(0)) await tail.kill()
})

afterAll(async () => {
  await store?.close()
  rmSync(dir, { recursive: true, force: true })
  if (project !== undefined) rmSync(project.dir, { recursive: true, force: true })
})

/** Appends one event per type, in one transaction, and answers their seqs in order. */
async function append(types: string[]): Promise<number[]> {
  const events = types.map(
    (type) =>
      makeEvent(
        type,
        { tag: randomUUID() },
        { correlationId: `ac7:${randomUUID()}` },
      ) as NymbalEvent<unknown>,
  )
  await store.transaction((tx) => repos.eventLog.append(tx, events))
  const ids = new Set(events.map((e) => e.id))
  const logged = await store.read((tx) => repos.eventLog.listAll(tx))
  return logged.filter((row) => ids.has(row.event.id)).map((row) => row.seq)
}

async function currentMax(): Promise<number> {
  const logged = await store.read((tx) => repos.eventLog.listAll(tx))
  return logged.reduce((max, row) => Math.max(max, row.seq), 0)
}

async function tail(args: string[] = []): Promise<Tail> {
  const t = await startTail(args, { cwd: project.dir, env: project.env })
  tails.push(t)
  return t
}

describe('AC-7: nymbal events tail', () => {
  it('AC-7: started on a running store, it reports the current maximum seq in its ready line, prints none at or below it, and then, property over appends awaited one after another, prints exactly the appended seqs, each once, strictly increasing; SIGINT exits 0', async () => {
    const max = await currentMax()
    const t = await tail()
    expect(t.readyAt, 'tailing from seq <the current maximum>').toBe(max)

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.constantFrom('order.placed.v1', 'cart.updated.v1', 'inventory.changed.v1'), {
            minLength: 1,
            maxLength: 3,
          }),
          {
            minLength: 1,
            maxLength: 3,
          },
        ),
        async (batches) => {
          const from = t.seqs().length
          const appended: number[] = []
          for (const batch of [...batches, ['tail.fence.v1']]) {
            const seqs = await append(batch)
            appended.push(...seqs)
            await t.waitForSeq(seqs[seqs.length - 1]!)
          }
          const printed = t.seqs().slice(from)
          expect(printed).toEqual(appended)
          expect(printed.every((seq, i) => i === 0 || seq > printed[i - 1]!)).toBe(true)
        },
      ),
      { numRuns: 5, endOnFailure: true },
    )
    expect(
      t.seqs().filter((seq) => seq <= max),
      'history printed by default',
    ).toEqual([])

    const exit = await t.interrupt()
    expect(exit, t.output()).toEqual({ code: 0, signal: null })
  }, 120_000)

  it('AC-7: --from <seq> starts there: it prints the events above that seq, then the new ones', async () => {
    const history = await append(['from.a.v1', 'from.b.v1', 'from.c.v1'])
    const from = history[0]!
    const t = await tail(['--from', String(from)])
    expect(t.readyAt).toBe(from)
    const later = await currentMax()
    await t.waitForSeq(later)
    const [fresh] = await append(['from.d.v1'])
    await t.waitForSeq(fresh!)

    const all = await store.read((tx) => repos.eventLog.listAll(tx))
    expect(t.seqs()).toEqual(all.filter((row) => row.seq > from).map((row) => row.seq))
  }, 60_000)

  it("AC-7: --type 'order.*' prints only the order.… events appended while tailing", async () => {
    const t = await tail(['--type', 'order.*'])
    const types = [
      'order.placed.v1',
      'cart.updated.v1',
      'order.paid.v1',
      'cart.updated.v1',
      'order.fence.v1',
    ]
    const seqs: number[] = []
    for (const type of types) seqs.push(...(await append([type])))
    await t.waitForSeq(seqs[seqs.length - 1]!)

    expect(t.seqs()).toEqual(seqs.filter((_, i) => types[i]!.startsWith('order.')))
  }, 60_000)
})
