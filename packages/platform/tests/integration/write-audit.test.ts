import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CATEGORY_UPDATED, type Category } from '@nymbalhq/types'
import { rawClients, sqliteTurn } from '../../src/db/command-store.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { describeViolation, writeAuditViolations } from '../support/write-audit.js'

// The write audit itself, on a kernel from createKernel (which installs it): a transaction through the kernel's store
// that writes a category row and appends no event is one violation naming the table and the test, however the write
// is nested in it; the same change through the category service, which publishes in the writing transaction, is
// none; rows seeded through the raw connection before any command never reach a check. Each test drains what it
// produced, so the setup file's afterEach sees nothing.

let k: Kernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await k?.close()
})

const currentTest = () => expect.getState().currentTestName

async function nameOf(r: RawReader, id: string): Promise<string> {
  const row = await r.one<{ name: string }>('SELECT name FROM categories WHERE id = ?', [id])
  return row.name
}

async function category(): Promise<Category> {
  const tag = randomUUID().slice(0, 8)
  return k.services.category.create({ slug: `audit-${tag}`, name: `audit ${tag}` })
}

describe('AC-8: the write audit', () => {
  it('AC-8: a category row written through the kernel store in a transaction that appends no event is one violation naming categories and the test, whether the write is direct or nested in a joined transaction and a savepoint', async () => {
    const { id } = await category()
    writeAuditViolations()

    const direct = `direct ${randomUUID()}`
    await k.store.transaction((tx) => k.repos.category.update(tx, id, { name: direct }))
    expect(await nameOf(raw, id), 'the direct write committed').toBe(direct)
    expect(
      writeAuditViolations().map((v) => ({
        rule: v.rule,
        categories: v.tables['categories'],
        events: v.events,
        test: v.test,
      })),
    ).toEqual([
      {
        rule: 'domain change with no event',
        categories: { update: 1 },
        events: [],
        test: currentTest(),
      },
    ])

    const nested = `nested ${randomUUID()}`
    await k.store.transaction(async () => {
      await k.store.transaction((tx) => k.repos.category.update(tx, id, { name: `${nested} 1` }))
      await k.store.savepoint((tx) => k.repos.category.update(tx, id, { name: nested }))
    })
    expect(await nameOf(raw, id), 'the nested writes committed').toBe(nested)
    // One outermost transaction is one check, holding both writes: a joined transaction counted as outermost would
    // split them, or check the inner one alone.
    expect(
      writeAuditViolations().map((v) => ({ categories: v.tables['categories'], test: v.test })),
    ).toEqual([{ categories: { update: 2 }, test: currentTest() }])
  })

  it('AC-8: a write in a joined inner transaction whose outermost transaction then appends the event is no violation', async () => {
    const { id } = await category()
    writeAuditViolations()
    const before = await maxSeq(raw)

    const renamed = `joined ${randomUUID()}`
    await k.store.transaction(async () => {
      await k.store.transaction((tx) => k.repos.category.update(tx, id, { name: renamed }))
      const fresh = await k.store.read((tx) => k.repos.category.findById(tx, id))
      await k.publisher.publish(EVT_CATEGORY_UPDATED, { category: fresh as Category })
    })

    expect(writeAuditViolations().map(describeViolation)).toEqual([])
    expect(await nameOf(raw, id)).toBe(renamed)
    expect((await eventRows(raw, 'seq > ?', [before])).map((r) => r.type)).toEqual([
      EVT_CATEGORY_UPDATED,
    ])
  })

  it('AC-8: the same category update through the category service is no violation, and its transaction appends category.updated.v1', async () => {
    const { id } = await category()
    expect(writeAuditViolations().map(describeViolation), 'the create').toEqual([])
    const before = await maxSeq(raw)

    const renamed = `service ${randomUUID()}`
    await k.services.category.update(id, { name: renamed })

    expect(writeAuditViolations().map(describeViolation), 'the update').toEqual([])
    expect(await nameOf(raw, id)).toBe(renamed)
    expect((await eventRows(raw, 'seq > ?', [before])).map((r) => r.type)).toEqual([
      EVT_CATEGORY_UPDATED,
    ])
  })

  it('AC-8: category rows seeded through rawClients(store).raw before the first command never reach a check: the next transaction, which changes nothing, is no violation', async () => {
    const own = await createKernel({ dialect: 'sqlite' })
    const ownRaw = openRaw(own.dialect, own.target)
    try {
      writeAuditViolations()
      const clients = rawClients(own.store)
      if (clients.kind !== 'sqlite') throw new Error('expected a SQLite store')
      const before = await ownRaw.count('categories')
      const seeded = 3
      await sqliteTurn(clients.raw, () => {
        const insert = clients.raw.prepare(
          'INSERT INTO categories (id, slug, name, created_at) VALUES (?, ?, ?, ?)',
        )
        for (let i = 0; i < seeded; i += 1) {
          const id = randomUUID()
          insert.run(id, `seeded-${id}`, `seeded ${i}`, new Date().toISOString())
        }
      })

      const found = await own.store.transaction((tx) => own.repos.category.list(tx))

      expect(await ownRaw.count('categories')).toBe(before + seeded)
      expect(found.length).toBe(before + seeded)
      expect(writeAuditViolations().map(describeViolation)).toEqual([])
    } finally {
      await ownRaw.close()
      await own.close()
    }
  })
})
