import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCommandStore } from '../../src/db/command-store.js'
import { rebuild } from '../../src/read-models/index.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { rebuildDeps } from '../support/read-models.js'

// GET /api/categories answers every category the store has, however many, in display order. The categories are
// written through the repositories on a second connection to the kernel's file (a seed, not a command: no event), and
// the catalogue read model is rebuilt from the tables once, as a boot does.

const CATEGORIES = 1234

/** A seeded permutation of 0..n-1, so the positions are shuffled the same way on every run. */
function shuffled(n: number, seed: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i)
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('GET /api/categories', () => {
  it(`AC-9: on a store with ${CATEGORIES} categories at shuffled positions, answers all of them, ids equal to the store's, in non-decreasing position`, async () => {
    const k = await createKernel({ dialect: 'sqlite' })
    let served: ServedKernel | undefined
    try {
      const seed = createCommandStore(k.config, { sqlitePath: k.target })
      try {
        const positions = shuffled(CATEGORIES, 27)
        const tag = randomUUID().slice(0, 8)
        await seed.transaction(async (tx) => {
          for (const [i, position] of positions.entries()) {
            await k.repos.category.insert(tx, {
              id: randomUUID(),
              slug: `all-${tag}-${i}`,
              name: `All ${i}`,
              position,
              createdAt: new Date(),
            })
          }
        })
      } finally {
        await seed.close()
      }
      await rebuild(['catalogue'], rebuildDeps(k))
      const storeIds = (await k.store.read((tx) => k.repos.category.list(tx))).map((c) => c.id)
      expect(storeIds.length, 'the store holds the seeded categories').toBe(CATEGORIES)

      served = await serveKernel(k)
      const res = await fetch(new URL('/api/categories', served.baseUrl))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Array<{ id: string; position: number }> }

      expect(body.data.length, 'categories answered').toBe(storeIds.length)
      expect(body.data.map((c) => c.id).sort()).toEqual([...storeIds].sort())
      for (let i = 1; i < body.data.length; i++) {
        expect(body.data[i]!.position, `position at ${i}`).toBeGreaterThanOrEqual(
          body.data[i - 1]!.position,
        )
      }
    } finally {
      if (served !== undefined) await served.stop()
      else await k.close()
    }
  }, 60_000)
})
