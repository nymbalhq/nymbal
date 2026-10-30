import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { project } from '../../../../tests/support/project.js'
import {
  startFakeAlgolia,
  type FakeAlgolia,
} from '../../../adapters/search/algolia/src/tests/fake-algolia.js'
import { nativeIndexDocuments } from '../../src/adapters/search/native-adapter.js'
import { createCommandStore, rawClients } from '../../src/db/command-store.js'
import { createKernel, kernelConfig } from '../support/kernel.js'
import { ALGOLIA_PACKAGE_DIR, withSearch } from '../support/package-search.js'

// AC-7: `nymbal replay --to search`, the built CLI (`pnpm build` first), on a store whose search is algolia on the fake
// Algolia. The catalogue is made by a native kernel on a SQLite file, so native's own index of it is the oracle; the
// Algolia index holds a stale record from before. After the replay the index holds exactly the catalogue.

const API_KEY = 'algolia-admin-key'
const indexName = `replay-${randomUUID().slice(0, 8)}`
const dir = mkdtempSync(join(tmpdir(), 'algolia-replay-'))
const sqlitePath = join(dir, 'store.sqlite')
let fake: FakeAlgolia
let storeDir = ''
const created: string[] = []
const deleted: string[] = []

beforeAll(async () => {
  const k = await createKernel({ dialect: 'sqlite', sqlitePath })
  try {
    const tag = randomUUID().slice(0, 8)
    const cat = await k.services.category.create({
      slug: `rp-${tag}`,
      name: `Replay ${tag}`,
      description: '',
    })
    for (let i = 0; i < 7; i++) {
      const p = await k.services.product.create({
        slug: `replay-${tag}-${i}`,
        name: `Replay ${tag} item${i}`,
        description: `Item ${i} of the replay catalogue.`,
        status: 'active',
        categoryIds: i % 2 === 0 ? [cat.id] : [],
        variants: [
          { sku: `RP-${tag}-${i}`, name: 'Default', priceMinor: 900 + i, stock: 4, options: [] },
        ],
      })
      created.push(p.id)
    }
    await k.services.product.delete(created[6]!)
    deleted.push(created[6]!)
  } finally {
    await k.close()
  }

  fake = await startFakeAlgolia({ apiKey: API_KEY })
  fake.load(indexName, [
    {
      objectID: 'stale-1',
      type: 'product',
      fields: { slug: 'gone' },
      _terms: 'gone',
      categoryIds: [],
    },
  ])
  storeDir = project({ '@nymbalhq/search-algolia': ALGOLIA_PACKAGE_DIR }, { parent: dir })
  const config = withSearch({
    provider: 'algolia',
    config: { appId: 'FAKEAPP', indexName, host: fake.host },
  })(kernelConfig('sqlite'))
  writeFileSync(
    join(storeDir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
}, 60_000)

afterAll(async () => {
  await fake?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function catalogueIds(): Promise<string[]> {
  const store = createCommandStore(kernelConfig('sqlite'), { sqlitePath })
  try {
    return (await nativeIndexDocuments(rawClients(store))).map((d) => d.id).sort()
  } finally {
    await store.close()
  }
}

describe('AC-7: nymbal replay --to search fills an Algolia index', () => {
  it('AC-7: on an algolia store it prints search: swapped and index <n> for the catalogue size, and the index then holds exactly the catalogue, the stale record gone', async () => {
    const expected = await catalogueIds()
    // Precondition: the oracle is the catalogue, the deleted product left out.
    expect(expected).toEqual(created.filter((id) => !deleted.includes(id)).sort())

    const run = await runCli(['replay', '--to', 'search'], {
      cwd: storeDir,
      env: cliEnv({
        NYMBAL_SQLITE_PATH: sqlitePath,
        ALGOLIA_API_KEY: API_KEY,
        ALGOLIA_APP_ID: undefined,
        ALGOLIA_INDEX: undefined,
      }),
    })

    expect(run.code, run.out).toBe(0)
    expect(run.out).toMatch(/^search: swapped/m)
    expect(Number(/^\s*index (\d+)\s*$/m.exec(run.out)?.[1]), run.out).toBe(expected.length)
    expect(
      fake
        .records(indexName)
        .map((r) => r.objectID)
        .sort(),
    ).toEqual(expected)
  }, 90_000)
})
