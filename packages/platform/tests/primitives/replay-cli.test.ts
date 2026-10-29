import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { EVT_ORDER_PLACED, type DocumentStoreAdapter } from '@nymbalhq/types'
import { createRedisDocumentStore } from '../../../adapters/document-store/redis/src/index.js'
import { cliEnv, runCli, type CliRun } from '../../../../tests/support/doctor'
import { deleteUnder, keysUnder, redis, redisServerUrl } from '../../../../tests/support/redis'
import { createNativeSearchAdapter } from '../../src/adapters/search/native-adapter.js'
import { createCommandStore, rawClients } from '../../src/db/command-store.js'
import { createEventBuilder } from '../../src/events/builder.js'
import { createLogger } from '../../src/logger.js'
import { address, createKernel, kernelConfig } from '../support/kernel.js'
import { withInfrastructure } from '../support/primitive-graph.js'
import { ALL_MODELS, DOCUMENT_COLLECTIONS, collectionOf } from '../support/read-model-shapes.js'

// AC-5: `nymbal replay`, the built CLI against a SQLite command store whose read models are on the composed Redis (a
// prefix of this file's own). Each case reads the outcome from the stores, never from what the command says it did.
// The in-memory case is a second project on the same file with `documentStore: 'in-memory'`. Faults are real: a table
// the catalogue rebuilder reads is renamed away; a logged, undelivered order.placed.v1 has a payload the order
// projection cannot read. Needs `pnpm build` (the CLI and the store packages) and Redis (NYMBAL_TEST_REDIS_URL).

const logger = createLogger({ pretty: false, level: 'silent' })
const url = redisServerUrl()
const prefix = `replay-run-${randomUUID().slice(0, 8)}`
const dir = mkdtempSync(join(tmpdir(), 'replay-run-cli-'))
const dbPath = join(dir, 'store.sqlite')
const WORDS = ['quartz', 'juniper', 'saffron', 'obsidian'] as const

let config: NymbalConfig
let redisProject: string
let memoryProject: string
let docs: DocumentStoreAdapter
const products: Array<{ id: string; word: string }> = []
const categorySlugs: string[] = []

/** A project directory whose nymbal.config.ts is the kernel's config on `documentStore` (the file via NYMBAL_SQLITE_PATH). */
function project(documentStore: 'redis' | 'in-memory'): string {
  const infrastructure =
    documentStore === 'redis'
      ? { commandStore: 'sqlite', documentStore, eventBus: 'in-process', redis: { url, prefix } }
      : { commandStore: 'sqlite', documentStore, eventBus: 'in-process' }
  const target = mkdtempSync(join(dir, `${documentStore}-project-`))
  writeFileSync(
    join(target, 'nymbal.config.ts'),
    `export default ${JSON.stringify({ ...config, infrastructure }, null, 2)}\n`,
  )
  return target
}

const replay = (cwd: string, ...args: string[]): Promise<CliRun> =>
  runCli(['replay', ...args], { cwd, env: cliEnv({ NYMBAL_SQLITE_PATH: dbPath }) })

/** Every key under the prefix with its contents, as Redis holds them. */
async function keyspace(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of (await keysUnder(url, prefix)).sort()) {
    const [type] = (await redis(url, [['TYPE', key]])) as [string]
    const [value] =
      type === 'hash'
        ? await redis(url, [['HGETALL', key]])
        : type === 'zset'
          ? await redis(url, [['ZRANGE', key, '0', '-1', 'WITHSCORES']])
          : type === 'set'
            ? await redis(url, [['SMEMBERS', key]])
            : await redis(url, [['GET', key]])
    out[key] = { type, value: type === 'set' ? (value as string[]).sort() : value }
  }
  return out
}

/** Runs `sql` on the file on a connection of its own; returns the last insert's rowid. */
function onFile(sql: string, params: unknown[] = []): number {
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    return Number(db.prepare(sql).run(...params).lastInsertRowid)
  } finally {
    db.close()
  }
}

function emptyNativeIndex(): void {
  onFile('DELETE FROM search_documents')
  onFile(`INSERT INTO search_documents_fts(search_documents_fts) VALUES ('delete-all')`)
}

/** What the file's native index answers for `word`, through an adapter of its own. */
async function searchIds(word: string): Promise<string[]> {
  const store = createCommandStore(kernelConfig('sqlite'), { sqlitePath: dbPath })
  try {
    const search = createNativeSearchAdapter({ sql: rawClients(store), logger })
    return (await search.search(word, { limit: 50 })).items.map((d) => d.id)
  } finally {
    await store.close()
  }
}

const token = (text: string) => new RegExp(`(?<![\\w.-])${text.replace(/[-]/g, '\\-')}(?![\\w.-])`)

/** Whether a line of `out` names `name` and the number `n`, each as a word of its own. */
function lineWith(out: string, name: string, n: number): boolean {
  return out.split('\n').some((line) => token(name).test(line) && token(String(n)).test(line))
}

beforeAll(async () => {
  const k = await createKernel({
    dialect: 'sqlite',
    sqlitePath: dbPath,
    configure: (c) =>
      withInfrastructure(c, {
        commandStore: 'sqlite',
        documentStore: 'redis',
        eventBus: 'in-process',
        redis: { url, prefix },
      }),
  })
  try {
    config = k.config
    const tag = randomUUID().slice(0, 8)
    const a = await k.services.category.create({ slug: `replay-a-${tag}`, name: `replay a ${tag}` })
    const b = await k.services.category.create({ slug: `replay-b-${tag}`, name: `replay b ${tag}` })
    categorySlugs.push(a.slug, b.slug)
    for (const [i, word] of WORDS.entries()) {
      const p = await k.services.product.create({
        slug: `replay-${word}-${tag}`,
        name: `${word} ${tag}`,
        status: 'active',
        categoryIds: [i % 2 === 0 ? a.id : b.id],
        variants: [
          {
            sku: `RP-${word}-${tag}`,
            name: 'Default',
            priceMinor: 1800,
            stock: 9,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
      products.push({ id: p.id, word })
    }
    const { customer } = await k.services.auth.register({
      email: `replay-${tag}@replay.test`,
      password: 'correct-horse-battery',
    })
    const p0 = await k.services.product.getById(products[0]!.id)
    const cart = await k.services.cart.getOrCreate(undefined, customer.id)
    await k.services.cart.addItem(cart.token, {
      variantId: p0.variants[0]!.id,
      productId: p0.id,
      productName: p0.name,
      variantName: 'Default',
      priceMinor: 1800,
      imageUrl: '',
      qty: 1,
    })
    await k.services.checkout.beginCheckout({
      cartToken: cart.token,
      customerId: customer.id,
      email: `replay-${tag}+stub-pending@replay.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    await k.app.relay.drain()
  } finally {
    await k.close()
  }
  redisProject = project('redis')
  memoryProject = project('in-memory')
  docs = await createRedisDocumentStore({ url, prefix, sweepIntervalMs: 0 })
}, 120_000)

afterAll(async () => {
  await docs?.close()
  await deleteUnder(url, prefix)
  rmSync(dir, { recursive: true, force: true })
})

/** Edits one category document by hand, as drift; returns it as it was. */
async function driftCategory(slug: string, name: string): Promise<Record<string, unknown>> {
  const original = await docs.get<Record<string, unknown>>('categories', slug)
  expect(original?.['slug'], `the categories document ${slug} exists`).toBe(slug)
  await docs.put('categories', slug, { ...original, name })
  return original!
}

describe('AC-5: nymbal replay on a Redis document store', () => {
  it('AC-5: --to search on a store whose native index was emptied exits 0, and the index then finds every product by its own word', async () => {
    emptyNativeIndex()
    for (const p of products) expect(await searchIds(p.word), `${p.word} before`).toEqual([])

    const run = await replay(redisProject, '--to', 'search')

    expect(run.code, run.out).toBe(0)
    const found = new Set<string>()
    for (const p of products) for (const id of await searchIds(p.word)) found.add(id)
    expect([...found].sort()).toEqual(products.map((p) => p.id).sort())
  })

  it('AC-5: --to catalogue --dry-run on an in-sync store exits 0 and changes nothing in the document store', async () => {
    const before = await keyspace()
    expect(
      Object.keys(before).length,
      'the kernel left read models under the prefix',
    ).toBeGreaterThan(0)

    const run = await replay(redisProject, '--to', 'catalogue', '--dry-run')

    expect(run.code, run.out).toBe(0)
    expect(await keyspace()).toEqual(before)
  })

  it('AC-5: after a categories document is edited by hand, --to catalogue --dry-run exits 1, names the collection with the count 1, and changes nothing', async () => {
    const original = await driftCategory(categorySlugs[0]!, 'edited by hand (dry run)')
    try {
      const before = await keyspace()

      const run = await replay(redisProject, '--to', 'catalogue', '--dry-run')

      expect(run.code, run.out).toBe(1)
      expect(lineWith(run.out, 'categories', 1), run.out).toBe(true)
      expect(await keyspace()).toEqual(before)
    } finally {
      await docs.put('categories', categorySlugs[0]!, original)
    }
  })

  it('AC-5: a catalogue rebuilder that fails (a table it reads renamed away) exits 2 naming the read model, and every catalogue collection keeps its old contents, a hand edit included', async () => {
    const original = await driftCategory(categorySlugs[1]!, 'edited by hand (failure)')
    try {
      const before = await keyspace()
      onFile('ALTER TABLE variants RENAME TO variants_replay_hidden')
      let run: CliRun
      try {
        run = await replay(redisProject, '--to', 'catalogue')
      } finally {
        onFile('ALTER TABLE variants_replay_hidden RENAME TO variants')
      }

      expect(run.code, run.out).toBe(2)
      expect(run.out).toMatch(token('catalogue'))
      expect(await keyspace()).toEqual(before)
    } finally {
      await docs.put('categories', categorySlugs[1]!, original)
    }
  })

  it('AC-5: --to all exits 0, prints a report naming every read model and each document collection with the count it now holds, and repairs a hand-made drift', async () => {
    const original = await driftCategory(categorySlugs[0]!, 'edited by hand (all)')

    const run = await replay(redisProject, '--to', 'all')

    expect(run.code, run.out).toBe(0)
    for (const model of ALL_MODELS) expect(run.out, model).toMatch(token(model))
    for (const name of DOCUMENT_COLLECTIONS) {
      const held = (await collectionOf(docs, name)).length
      expect(lineWith(run.out, name, held), `${name} ${held}\n${run.out}`).toBe(true)
    }
    expect(await docs.get('categories', categorySlugs[0]!)).toEqual(original)
  })

  it('AC-5: a logged, undelivered order.placed.v1 whose handler fails in catch-up makes --to orders exit 2, naming the event’s seq and saying the model is swapped', async () => {
    const make = createEventBuilder({
      storeId: config.store.name,
      environment: 'development',
      version: '0.0.0',
      source: 'replay-poison',
    })
    const poison = make(EVT_ORDER_PLACED, {})
    const seq = onFile(
      `INSERT INTO events (id, type, envelope, correlation_id, created_at, delivered_at, attempts, dead_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)`,
      [poison.id, poison.type, JSON.stringify(poison), poison.correlationId, poison.timestamp],
    )
    try {
      const run = await replay(redisProject, '--to', 'orders')

      expect(run.code, run.out).toBe(2)
      expect(run.out).toMatch(token(String(seq)))
      expect(run.out).toMatch(/swapped/i)
    } finally {
      onFile('DELETE FROM events WHERE id = ?', [poison.id])
    }
  })
})

describe('AC-5: nymbal replay on an in-memory document store', () => {
  it('AC-5: --to catalogue exits 2 saying the read model lives in the server’s process, a restart rebuilds it, and redis or postgres-jsonb shares it; --to search still exits 0 and refills the native index', async () => {
    const refused = await replay(memoryProject, '--to', 'catalogue')

    expect(refused.code, refused.out).toBe(2)
    expect(refused.out).toMatch(/restart/i)
    expect(refused.out).toMatch(/\bredis\b/)
    expect(refused.out).toMatch(/postgres-jsonb/)

    emptyNativeIndex()
    const run = await replay(memoryProject, '--to', 'search')

    expect(run.code, run.out).toBe(0)
    for (const p of products) expect(await searchIds(p.word), p.word).toContain(p.id)
  })
})
