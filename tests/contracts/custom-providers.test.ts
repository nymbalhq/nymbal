import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '@nymbalhq/config'
import { runPaymentsContract, runSearchContract } from '@nymbalhq/contract-tests'
import type { PaymentsAdapter, SearchAdapter } from '@nymbalhq/types'

// P2-05 decisions 8 and 9: the swap fixture (tests/e2e/fixtures/custom-providers), loaded the way `nymbal dev` loads
// it (loadConfig, which returns the config module's named `adapters` export), injects adapters that pass the search
// and payments contracts, and its search is what the spec says: no `facet`, and a case-insensitive substring match on
// the name. Kills: a loader that drops the `adapters` export, a fixture that only looks like an adapter, and a search
// that matches on something else (a description match keeps the native results and hides the swap).

const FIXTURE_DIR = fileURLToPath(new URL('../e2e/fixtures/custom-providers/', import.meta.url))

let search: SearchAdapter | undefined
let payments: PaymentsAdapter | undefined
let slots: string[] = []

beforeAll(async () => {
  const loaded = (await loadConfig(FIXTURE_DIR)) as {
    adapters?: { search?: SearchAdapter; payments?: PaymentsAdapter }
  }
  search = loaded.adapters?.search
  payments = loaded.adapters?.payments
  slots = Object.keys(loaded.adapters ?? {}).sort()
})

/** The loaded adapter, or a failure naming what loadConfig did not return. */
function loadedOr<T>(adapter: T | undefined, slot: string): T {
  if (adapter === undefined)
    throw new Error(`loadConfig returned no adapters.${slot} for ${FIXTURE_DIR}`)
  return adapter
}

runSearchContract(() => loadedOr(search, 'search'))
runPaymentsContract(() => loadedOr(payments, 'payments'))

describe('P2-05 swap fixture, as loadConfig returns it', () => {
  it('AC-5: loadConfig returns the fixture config module’s adapters export, one adapter per custom slot', () => {
    expect(slots).toEqual(['payments', 'search'])
  })

  it('AC-5: the fixture search reports index and search, and not facet', () => {
    const caps = loadedOr(search, 'search').capabilities()
    expect([...caps].sort()).toEqual(['index', 'search'])
    expect(caps.includes('facet')).toBe(false)
  })

  it('AC-5: the fixture payments adapter has no client half: client() is null', () => {
    const adapter = loadedOr(payments, 'payments') as PaymentsAdapter & { client?: () => unknown }
    expect(typeof adapter.client).toBe('function')
    expect(adapter.client!()).toBeNull()
  })

  it('AC-5: over generated names and queries, search returns exactly the indexed products whose name contains the query, ignoring case', async () => {
    const adapter = loadedOr(search, 'search')
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 3 }),
        fc.boolean(),
        async (names, query, upper) => {
          // One shared adapter instance (the loaded one): each run indexes under ids of its own and removes them,
          // so runs do not see each other.
          run += 1
          const ids = names.map((_, i) => `p2-05-run-${run}-${i}`)
          await adapter.index(
            names.map((name, i) => ({
              id: ids[i]!,
              type: 'product',
              fields: { name, description: query },
            })),
          )
          try {
            const q = upper ? query.toUpperCase() : query
            const found = await adapter.search(q, { limit: 1000 })
            const mine = new Set(ids)
            const expected = names
              .map((name, i) => ({ name, id: ids[i]! }))
              .filter(({ name }) => name.toLowerCase().includes(q.trim().toLowerCase()))
              .map(({ id }) => id)
            expect(
              found.items
                .map((d) => d.id)
                .filter((id) => mine.has(id))
                .sort(),
            ).toEqual(expected.sort())
          } finally {
            await adapter.remove(ids)
          }
        },
      ),
    )
  })
})
