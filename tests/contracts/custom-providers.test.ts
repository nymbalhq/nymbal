import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '@nymbalhq/config'
import {
  matchesQuery,
  runPaymentsContract,
  runSearchContract,
  toSearchDocument,
  type ContractProduct,
} from '@nymbalhq/contract-tests'
import type { PaymentsAdapter, SearchAdapter } from '@nymbalhq/types'
import { encodeFixtureCursor } from '../e2e/fixtures/custom-providers/adapters'

// The swap fixture (tests/e2e/fixtures/custom-providers), loaded the way `nymbal dev` loads it (loadConfig, which
// returns the config module's named `adapters` export), injects adapters that pass the search and payments contracts,
// and its search has no `facet` and matches over name, SKU, variant name and description, paged by cursor with an
// exact total. The suites and the search oracle come from the package, so the fixture runs the cases a third party
// certifies against, the refund idempotency case included.

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

// AC-1 and AC-4 on the fixture: no `facet`, no ranking promised.
runSearchContract('custom fixture', () => loadedOr(search, 'search'), {
  cursorAt: encodeFixtureCursor,
})
runPaymentsContract('custom fixture', () => loadedOr(payments, 'payments'))

describe('swap fixture, as loadConfig returns it', () => {
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

  // A description, SKU or variant-name match counts, case and punctuation separate terms, and each query term is a
  // prefix.
  it('AC-5: over generated products and queries in mixed case and punctuation, the loaded fixture returns exactly the products the search rule matches through name, SKU, variant name or description', async () => {
    const adapter = loadedOr(search, 'search')
    const text = (maxLength: number) =>
      fc.string({ unit: fc.constantFrom('a', 'B', 'c', '1', ' ', '-', '.', 'é'), maxLength })
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: text(12),
            description: text(12),
            variants: fc.array(fc.record({ sku: text(5), name: text(6) }), { maxLength: 2 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        text(4),
        async (generated, query) => {
          // One shared adapter instance (the loaded one): each run indexes under ids of its own and removes them,
          // so runs do not see each other.
          run += 1
          const products: ContractProduct[] = generated.map((g, i) => ({
            id: `caps-run-${run}-${i}`,
            name: g.name,
            description: g.description,
            variants: g.variants.map((v) => ({ ...v, priceMinor: 100 })),
            categoryIds: [],
          }))
          await adapter.index(products.map(toSearchDocument))
          try {
            const found = await adapter.search(query, { limit: 1000 })
            const mine = new Set(products.map((p) => p.id))
            const expected = products.filter((p) => matchesQuery(p, query)).map((p) => p.id)
            expect(
              found.items
                .map((d) => d.id)
                .filter((id) => mine.has(id))
                .sort(),
              JSON.stringify(query),
            ).toEqual(expected.sort())
          } finally {
            await adapter.remove([...products.map((p) => p.id)])
          }
        },
      ),
    )
  })
})
