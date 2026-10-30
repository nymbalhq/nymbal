import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_PRODUCT_CREATED,
  type IndexResult,
  type SearchAdapter,
  type SearchDocument,
} from '@nymbalhq/types'
import { cliEnv, doctorJson, migratedSqlite, runCli } from '../../../../tests/support/doctor.js'
import { project } from '../../../../tests/support/project.js'
import {
  startFakeAlgolia,
  type FakeAlgolia,
} from '../../../adapters/search/algolia/src/tests/fake-algolia.js'
import { adminSession } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, kernelConfig, type Kernel } from '../support/kernel.js'
import {
  ACME_SEARCH_FIXTURE,
  ALGOLIA_PACKAGE_DIR,
  acmeSearchState,
  eventRows,
  inProject,
  isRecordWrite,
  lastSeq,
  withSearch,
} from '../support/package-search.js'

// AC-5: a search slot on a package (a third party's, or @nymbalhq/search-algolia on the fake Algolia) is not rebuilt
// at boot: a restart writes nothing to it, while `custom` is still rebuilt. With its key set nowhere the store boots,
// reports search down (doctor) and without capabilities (GET /api/capabilities), and a product created through the API
// is listed with no event dead or retrying. Kernels run from `src/` with a store project as the working directory, so
// they import the packages from its node_modules; the doctor case runs the built CLI (`pnpm build` first).

const dirs: string[] = []
let store = ''
let fake: FakeAlgolia
const catalogueIds: string[] = []

beforeAll(async () => {
  store = mkdtempSync(join(tmpdir(), 'package-search-boot-'))
  dirs.push(store)
  store = project(
    { '@nymbalhq/search-algolia': ALGOLIA_PACKAGE_DIR, '@acme/nymbal-search': ACME_SEARCH_FIXTURE },
    { parent: store, prefix: 'store-' },
  )
  fake = await startFakeAlgolia({ apiKey: 'algolia-admin-key' })
}, 60_000)

afterAll(async () => {
  await fake?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A SQLite file whose catalogue a native kernel made: three active products, every event delivered. */
async function catalogue(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'package-search-catalogue-'))
  dirs.push(dir)
  const sqlitePath = join(dir, 'store.sqlite')
  const k = await createKernel({ dialect: 'sqlite', sqlitePath })
  try {
    catalogueIds.length = 0
    const tag = randomUUID().slice(0, 8)
    for (let i = 0; i < 3; i++) {
      const p = await k.services.product.create({
        slug: `boot-${tag}-${i}`,
        name: `Boot ${tag} item${i}`,
        status: 'active',
        variants: [
          { sku: `BOOT-${tag}-${i}`, name: 'Default', priceMinor: 1000, stock: 2, options: [] },
        ],
      })
      catalogueIds.push(p.id)
    }
    // Every event delivered, so a later boot has nothing for the live feed to index: only a rebuild could write.
    await k.app.relay.drain()
  } finally {
    await k.close()
  }
  return sqlitePath
}

/** A custom search adapter that keeps what each replaceAll was given. */
function recordingSearch(): { adapter: SearchAdapter; replaced: string[][] } {
  const replaced: string[][] = []
  const adapter: SearchAdapter = {
    kind: 'search',
    providerName: 'recording',
    capabilities: () => ['index', 'search'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    index: async (docs: SearchDocument[]): Promise<IndexResult> => ({ indexed: docs.length }),
    remove: async () => undefined,
    async replaceAll(docs) {
      const ids: string[] = []
      for await (const d of docs) ids.push(d.id)
      replaced.push(ids)
    },
    search: async () => ({ items: [], total: 0, nextCursor: null }),
    facet: async (field) => ({ field, label: field, values: [] }),
  }
  return { adapter, replaced }
}

const ACME = { provider: 'acme', package: '@acme/nymbal-search' }
const algoliaBlock = (config: Record<string, unknown>) => ({
  provider: 'algolia',
  config: { appId: 'FAKEAPP', host: fake.host, ...config },
})

describe('AC-5: boot does not rebuild a package search index', () => {
  it('AC-5: a restart on a third party search package writes nothing to its index, while a custom index is still rebuilt from the catalogue at boot', async () => {
    const sqlitePath = await catalogue()
    const acme = acmeSearchState()
    const before = acme.writes.length

    const k = await inProject(store, () =>
      createKernel({
        dialect: 'sqlite',
        sqlitePath,
        configure: withSearch({ ...ACME, config: { apiKey: 'acme-key' } }),
      }),
    )
    await k.close()
    expect(acme.writes.slice(before)).toEqual([])

    const custom = recordingSearch()
    const c = await createKernel({
      dialect: 'sqlite',
      sqlitePath,
      configure: withSearch({ provider: 'custom' }),
      appOptions: { adapters: { search: custom.adapter } },
    })
    await c.close()
    expect(custom.replaced.map((ids) => [...ids].sort())).toEqual([[...catalogueIds].sort()])
  }, 60_000)

  it('AC-5: a restart on algolia (the fake) makes no index write, and the index keeps what it held', async () => {
    const sqlitePath = await catalogue()
    const indexName = `boot-${randomUUID().slice(0, 8)}`
    fake.load(indexName, [
      {
        objectID: 'kept-1',
        type: 'product',
        fields: { slug: 'kept-1' },
        _terms: 'kept',
        categoryIds: [],
      },
    ])
    const held = fake.records(indexName)
    const from = fake.requests.length

    const k = await inProject(store, () =>
      createKernel({
        dialect: 'sqlite',
        sqlitePath,
        configure: withSearch(algoliaBlock({ apiKey: 'algolia-admin-key', indexName })),
      }),
    )
    const capabilities = [...k.app.adapters.search.capabilities()].sort()
    await k.close()

    expect(capabilities).toEqual(['facet', 'index', 'search'])
    const writes = fake.requests.slice(from).filter(isRecordWrite)
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([])
    expect(fake.records(indexName)).toEqual(held)
  }, 60_000)
})

describe.each([
  { label: 'a third party search package', block: () => ({ ...ACME }), unset: ['ACME_SEARCH_KEY'] },
  {
    label: 'algolia',
    block: () => algoliaBlock({ indexName: `nokey-${randomUUID().slice(0, 8)}` }),
    unset: ['ALGOLIA_API_KEY'],
  },
])('AC-5: $label with its key set nowhere', ({ block, unset }) => {
  let k: Kernel | undefined
  let served: ServedKernel | undefined
  const saved = new Map<string, string | undefined>()

  beforeAll(() => {
    for (const name of unset) {
      saved.set(name, process.env[name])
      delete process.env[name]
    }
  })
  afterAll(async () => {
    if (served !== undefined) await served.stop()
    else await k?.close()
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('AC-5: the store boots; GET /api/capabilities gives search no capabilities; a product created through the API is listed, and no event is dead or retrying', async () => {
    k = await inProject(store, () =>
      createKernel({ dialect: 'sqlite', configure: withSearch(block()) }),
    )
    served = await serveKernel(k)
    const caps = await fetch(`${served.baseUrl}/api/capabilities`, {
      headers: { accept: 'application/json' },
    })
    expect(caps.status).toBe(200)
    const report = ((await caps.json()) as { data: { search: { capabilities: string[] } } }).data
    expect(report.search.capabilities).toEqual([])

    const admin = await adminSession(k, served.baseUrl)
    const from = lastSeq(k.target)
    const slug = `nokey-${randomUUID().slice(0, 8)}`
    const created = await admin.send<{ id: string }>('POST', '/api/admin/products', {
      slug,
      name: 'Listed without a search key',
      description: '',
      status: 'active',
      variants: [{ sku: `NK-${slug}`, name: 'Default', priceMinor: 1200, stock: 1, options: [] }],
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await k.app.relay.drain()

    const listed = async () => {
      const res = await fetch(`${served!.baseUrl}/api/products?limit=100`, {
        headers: { accept: 'application/json' },
      })
      const body = (await res.json()) as { data?: { items?: Array<{ slug: string }> } }
      return (body.data?.items ?? []).map((p) => p.slug)
    }
    await expect.poll(listed, { timeout: 10_000 }).toContain(slug)
    const rows = eventRows(k.target, from)
    expect(rows.filter((r) => r.type === EVT_PRODUCT_CREATED).length).toBe(1)
    expect(
      rows.filter((r) => r.attempts > 0 || r.dead_at !== null || r.delivered_at === null),
    ).toEqual([])
  }, 60_000)
})

describe('AC-5: doctor on an algolia store with no key', () => {
  it('AC-5: nymbal doctor --json shows the search slot down, saying algolia is not configured for want of search.apiKey', async () => {
    const dir = project(
      { '@nymbalhq/search-algolia': ALGOLIA_PACKAGE_DIR },
      { parent: store, prefix: 'doctor-' },
    )
    const sqlitePath = join(dir, 'store.sqlite')
    await migratedSqlite(sqlitePath)
    const config = withSearch(algoliaBlock({ indexName: 'doctor' }))(kernelConfig('sqlite'))
    writeFileSync(
      join(dir, 'nymbal.config.ts'),
      `export default ${JSON.stringify(config, null, 2)}\n`,
    )

    const run = await runCli(['doctor', '--json'], {
      cwd: dir,
      env: cliEnv({
        NYMBAL_SQLITE_PATH: sqlitePath,
        ALGOLIA_API_KEY: undefined,
        ALGOLIA_APP_ID: undefined,
        ALGOLIA_INDEX: undefined,
      }),
    })

    const search = doctorJson(run.stdout).checks.find((c) => c.name === 'slot search')
    expect(search?.status, run.out).toBe('down')
    expect(search?.detail).toMatch(/algolia is not configured/)
    expect(search?.detail).toContain('search.apiKey')
  }, 60_000)
})
