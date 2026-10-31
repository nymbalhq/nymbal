import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { project } from '../../../../tests/support/project.js'
import {
  startFakeAlgolia,
  type AlgoliaRecord,
  type FakeAlgolia,
} from '../../../adapters/search/algolia/src/tests/fake-algolia.js'
import { adminSession, type AdminSession } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { ALGOLIA_PACKAGE_DIR, inProject, withSearch } from '../support/package-search.js'

// AC-6: the live feed, on a kernel whose search is @nymbalhq/search-algolia on the fake Algolia. A product created,
// updated and deleted through the admin API leaves its record written, changed and gone, and the storefront's search
// route finds it by a word of its name, by slug, with the category facet. The kernel runs from `src/` with a store
// project as the working directory; the package is built (`pnpm build` first).

const API_KEY = 'algolia-admin-key'
const indexName = `live-${randomUUID().slice(0, 8)}`
const dirs: string[] = []
let fake: FakeAlgolia
let served: ServedKernel
let admin: AdminSession

beforeAll(async () => {
  const parent = mkdtempSync(join(tmpdir(), 'algolia-live-'))
  dirs.push(parent)
  const store = project({ '@nymbalhq/search-algolia': ALGOLIA_PACKAGE_DIR }, { parent })
  fake = await startFakeAlgolia({ apiKey: API_KEY })
  const k = await inProject(store, () =>
    createKernel({
      dialect: 'sqlite',
      configure: withSearch({
        provider: 'algolia',
        config: { appId: 'FAKEAPP', apiKey: API_KEY, indexName, host: fake.host },
      }),
    }),
  )
  served = await serveKernel(k)
  admin = await adminSession(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await served?.stop()
  await fake?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface SearchBody {
  items: Array<{ slug: string }>
  total: number
  facets: Array<{ values: Array<{ value: string; label?: string; count?: number }> }>
}

async function searchFor(q: string): Promise<SearchBody> {
  const res = await fetch(`${served.baseUrl}/api/products/search?${new URLSearchParams({ q })}`, {
    headers: { accept: 'application/json' },
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: SearchBody }).data
}

const recordOf = (id: string): AlgoliaRecord | undefined =>
  fake.records(indexName).find((r) => r.objectID === id)
const termsOf = (id: string): string => String(recordOf(id)?.['_terms'] ?? '')

describe('AC-6: product changes keep the Algolia index current', () => {
  it('AC-6: a product created, renamed and deleted through the API is written, changed and removed in the index, and the search route finds it by slug with its category facet', async () => {
    const tag = randomUUID().replace(/-/g, '').slice(0, 8)
    const first = `kestrel${tag}`
    const second = `osprey${tag}`
    const category = await served.kernel.services.category.create({
      slug: `live-cat-${tag}`,
      name: `Lamps ${tag}`,
      description: '',
    })
    const slug = `live-${tag}`

    const created = await admin.send<{ id: string }>('POST', '/api/admin/products', {
      slug,
      name: `${first} Lamp`,
      description: 'A lamp for the live feed.',
      status: 'active',
      categoryIds: [category.id],
      variants: [{ sku: `LIVE-${tag}`, name: 'Default', priceMinor: 2500, stock: 3, options: [] }],
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.body.data!.id

    await expect.poll(() => termsOf(id), { timeout: 10_000 }).toContain(first)
    expect(recordOf(id)?.['fields']).toMatchObject({ slug })
    await expect.poll(async () => (await searchFor(first)).items.map((p) => p.slug)).toEqual([slug])
    const found = await searchFor(first)
    expect(found.total).toBe(1)
    expect(
      found.facets.flatMap((f) => f.values).find((v) => v.value === category.slug)?.count,
    ).toBe(found.items.filter((p) => p.slug === slug).length)

    const renamed = await admin.send('PATCH', `/api/admin/products/${id}`, {
      name: `${second} Lamp`,
    })
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200)
    await expect.poll(() => termsOf(id), { timeout: 10_000 }).toContain(second)
    expect(termsOf(id)).not.toContain(first)
    await expect
      .poll(async () => (await searchFor(second)).items.map((p) => p.slug))
      .toEqual([slug])
    expect((await searchFor(first)).total).toBe(0)

    const deleted = await admin.send('DELETE', `/api/admin/products/${id}`)
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
    await expect.poll(() => recordOf(id), { timeout: 10_000 }).toBeUndefined()
    expect((await searchFor(second)).total).toBe(0)
  }, 60_000)
})
