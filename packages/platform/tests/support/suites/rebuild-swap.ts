import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  diffReadModel,
  READ_MODELS,
  rebuild,
  SEARCH_INDEX,
  type ReadModelDiff,
  type ReadModelName,
  type RebuildReport,
} from '../../../src/read-models/index.js'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Kernel } from '../kernel.js'
import { ALL_MODELS, rebuildDeps } from '../read-models.js'

// A write made while `rebuild()` runs is readable through the swap. The rebuild of every model runs against the
// kernel's own read models (as `nymbal replay --to all` does on a shared document store) and stops at its `onPhase`
// hook: at `collected` of a model, writes go through the services and the in-process relay delivers them to the live
// read models; at `swapped` of a model, before its tail catch-up, the test reads what a shopper would. Every read is
// recorded inside the hook and asserted once the rebuild has returned.

type Phase = 'collected' | 'swapped'

interface Made {
  id: string
  slug: string
}

interface ProductBody {
  id: string
  slug: string
}

/** The model's own collections, as `diffReadModel` names them (the search model's is the index). */
function collectionsOf(model: ReadModelName): string[] {
  const m = READ_MODELS.find((r) => r.name === model)!
  return m.target === 'search' ? [SEARCH_INDEX] : [...m.collections]
}

const sorted = (xs: readonly string[]) => [...xs].sort()

/** Each collection of a diff with its added, changed and removed counts. */
const countsOf = (diff: ReadModelDiff) =>
  diff.collections.map(({ name, added, changed, removed }) => ({ name, added, changed, removed }))

/** What a diff of `model` against a live model that equals a fresh rebuild reports. */
const noDifference = (model: ReadModelName) =>
  collectionsOf(model).map((name) => ({ name, added: 0, changed: 0, removed: 0 }))

async function getData<T>(
  served: ServedKernel,
  path: string,
): Promise<{ status: number; data?: T }> {
  const res = await fetch(`${served.baseUrl}${path}`, { headers: { accept: 'application/json' } })
  const body = (await res.json().catch(() => ({}))) as { data?: T }
  return { status: res.status, ...(body.data !== undefined && { data: body.data }) }
}

/** The slugs `GET /api/products/:slug` serves, of `slugs`. */
async function servedOf(served: ServedKernel, slugs: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const slug of slugs) {
    const res = await getData<ProductBody>(served, `/api/products/${encodeURIComponent(slug)}`)
    if (res.status === 200 && res.data?.slug === slug) out.push(slug)
  }
  return out
}

/** The slugs the catalogue lists under `categorySlug`. */
async function listedOf(served: ServedKernel, categorySlug: string): Promise<string[]> {
  const res = await getData<{ items: ProductBody[] }>(
    served,
    `/api/products?${new URLSearchParams({ category: categorySlug, limit: '100' }).toString()}`,
  )
  return (res.data?.items ?? []).map((p) => p.slug)
}

/** The slugs and total the product search returns for `q`. */
async function searchedOf(
  served: ServedKernel,
  q: string,
): Promise<{ slugs: string[]; total: number }> {
  const res = await getData<{ items: ProductBody[]; total: number }>(
    served,
    `/api/products/search?${new URLSearchParams({ q, limit: '100' }).toString()}`,
  )
  return { slugs: (res.data?.items ?? []).map((p) => p.slug), total: res.data?.total ?? -1 }
}

type Op =
  | { kind: 'create' }
  | { kind: 'update'; pick: number; inCategory: boolean }
  | { kind: 'delete'; pick: number }

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('create' as const) }),
  fc.record({
    kind: fc.constant('update' as const),
    pick: fc.nat({ max: 20 }),
    inCategory: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('delete' as const), pick: fc.nat({ max: 20 }) }),
)

/** The models the interleaving writes at, in the order a rebuild of every model swaps them. */
const WRITTEN = ['catalogue', 'search'] as const
type Written = (typeof WRITTEN)[number]

export function rebuildSwapSuite(
  dialect: Kernel['dialect'],
  open: () => Promise<{ kernel: Kernel; drop(): Promise<void> }>,
  opts: { runs: number },
): void {
  describe(`writes during a rebuild are readable through the swap (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let drop: () => Promise<void>

    beforeAll(async () => {
      ;({ kernel: k, drop } = await open())
      served = await serveKernel(k)
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
      await drop?.()
    })

    async function createProduct(tag: string, name: string, categoryIds: string[]): Promise<Made> {
      const p = await k.services.product.create({
        slug: `swap-${tag}-${randomUUID().slice(0, 8)}`,
        name,
        status: 'active',
        categoryIds,
        variants: [
          {
            sku: `SW-${randomUUID()}`,
            name: 'Default',
            priceMinor: 1200,
            stock: 3,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
      return { id: p.id, slug: p.slug }
    }

    it("AC-1: for any k ≥ 1 products created at onPhase('collected', 'catalogue'), each is served by GET /api/products/:slug and listed under its category at onPhase('swapped', 'catalogue'), and found by the product search at onPhase('swapped', 'search'), before either tail catch-up", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (count) => {
          const tag = randomUUID().replace(/-/g, '').slice(0, 10)
          const token = `swap${tag}`
          const category = await k.services.category.create({
            slug: `swap-${tag}`,
            name: `swap ${tag}`,
          })
          await k.app.relay.drain()

          const created: string[] = []
          let servedBeforeSwap: string[] = []
          let servedAtSwap: string[] = []
          let listedAtSwap: string[] = []
          let searchedAtSwap = { slugs: [] as string[], total: -1 }

          await rebuild(
            ALL_MODELS,
            rebuildDeps(k, {
              onPhase: async (phase: Phase, model: ReadModelName) => {
                if (phase === 'collected' && model === 'catalogue') {
                  for (let i = 0; i < count; i++) {
                    created.push((await createProduct(tag, `${token} ${i}`, [category.id])).slug)
                  }
                  await k.app.relay.drain()
                  servedBeforeSwap = await servedOf(served, created)
                }
                if (phase === 'swapped' && model === 'catalogue') {
                  servedAtSwap = await servedOf(served, created)
                  listedAtSwap = await listedOf(served, category.slug)
                }
                if (phase === 'swapped' && model === 'search') {
                  searchedAtSwap = await searchedOf(served, token)
                }
              },
            }),
          )

          expect(created.length, "products created at onPhase('collected', 'catalogue')").toBe(
            count,
          )
          expect(sorted(servedBeforeSwap), 'served once the relay delivered them').toEqual(
            sorted(created),
          )
          expect(
            sorted(servedAtSwap),
            "served by GET /api/products/:slug at onPhase('swapped', 'catalogue')",
          ).toEqual(sorted(created))
          expect(
            sorted(listedAtSwap),
            "listed under their category at onPhase('swapped', 'catalogue')",
          ).toEqual(sorted(created))
          expect(
            sorted(searchedAtSwap.slugs),
            "found by the product search at onPhase('swapped', 'search')",
          ).toEqual(sorted(created))
          expect(searchedAtSwap.total, 'the search total at the swap').toBe(created.length)
        }),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 300_000)

    it("AC-2: over generated creates, updates and deletes at onPhase('collected') and onPhase('swapped') of catalogue and search, each model equals a fresh rebuild at its swap and after the rebuild; caughtUpBeforeSwap covers every write made before the model's swap and caughtUpEvents (the tail, from the margin) every write made before its tail", async () => {
      const writesAt = fc.array(op, { minLength: 1, maxLength: 3 })
      const maybeWritesAt = fc.array(op, { maxLength: 3 })
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            catalogue: fc.record({ collected: writesAt, swapped: maybeWritesAt }),
            search: fc.record({ collected: writesAt, swapped: maybeWritesAt }),
          }),
          async (plan) => {
            const tag = randomUUID().replace(/-/g, '').slice(0, 10)
            const category = await k.services.category.create({
              slug: `swap-${tag}`,
              name: `swap ${tag}`,
            })
            let alive: Made[] = []
            for (let i = 0; i < 3; i++) {
              alive.push(await createProduct(tag, `seed ${tag} ${i}`, [category.id]))
            }
            await k.app.relay.drain()

            // An update or delete with no product left creates one instead, so every op is one write.
            let edits = 0
            const apply = async (o: Op): Promise<void> => {
              const target =
                alive.length === 0 ? undefined : alive[('pick' in o ? o.pick : 0) % alive.length]
              if (o.kind === 'create' || target === undefined) {
                alive.push(await createProduct(tag, `made ${tag}`, [category.id]))
              } else if (o.kind === 'update') {
                edits += 1
                await k.services.product.update(target.id, {
                  name: `edit ${tag} ${edits}`,
                  categoryIds: o.inCategory ? [category.id] : [],
                })
              } else {
                await k.services.product.delete(target.id)
                alive = alive.filter((p) => p.id !== target.id)
              }
            }

            const seen: string[] = []
            const written: Record<Written, Record<Phase, number>> = {
              catalogue: { collected: 0, swapped: 0 },
              search: { collected: 0, swapped: 0 },
            }
            const atSwap: Partial<Record<Written, ReadModelDiff>> = {}
            const plain = rebuildDeps(k)

            const report: RebuildReport = await rebuild(
              ALL_MODELS,
              rebuildDeps(k, {
                onPhase: async (phase: Phase, model: ReadModelName) => {
                  seen.push(`${phase}:${model}`)
                  if (model !== 'catalogue' && model !== 'search') return
                  if (phase === 'swapped') atSwap[model] = await diffReadModel(model, plain)
                  for (const o of plan[model][phase]) await apply(o)
                  await k.app.relay.drain()
                  written[model][phase] = plan[model][phase].length
                },
              }),
            )
            await k.app.relay.drain()

            expect(seen, 'onPhase, per model in rebuild order: collected, then swapped').toEqual(
              ALL_MODELS.flatMap((m) => [`collected:${m}`, `swapped:${m}`]),
            )
            for (const model of WRITTEN) {
              expect(
                countsOf(atSwap[model]!),
                `${model} at onPhase('swapped'), before its tail, against a fresh rebuild`,
              ).toEqual(noDifference(model))
              expect(
                countsOf(await diffReadModel(model, plain)),
                `${model} after the rebuild, against a fresh rebuild`,
              ).toEqual(noDifference(model))
            }

            // Writes in the order the hooks ran: catalogue's collected and swapped, then search's.
            const beforeSwapOf: Record<Written, number> = {
              catalogue: written.catalogue.collected,
              search:
                written.catalogue.collected + written.catalogue.swapped + written.search.collected,
            }
            const beforeTailOf: Record<Written, number> = {
              catalogue: beforeSwapOf.catalogue + written.catalogue.swapped,
              search: beforeSwapOf.search + written.search.swapped,
            }
            for (const model of WRITTEN) {
              const entry = report.find((e) => e.model === model)!
              expect(
                entry.caughtUpBeforeSwap,
                `${model}: events caught up before the swap cover the writes made before it`,
              ).toBeGreaterThanOrEqual(beforeSwapOf[model])
              expect(
                entry.caughtUpEvents,
                `${model}: the tail re-applies from the margin, so it covers every write made before it`,
              ).toBeGreaterThanOrEqual(beforeTailOf[model])
            }
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 300_000)
  })
}
