import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PRODUCT_SORT,
  PRODUCT_SORT_KEYS,
  PRODUCT_SORT_LABELS,
  type ProductSortKey,
} from '@nymbalhq/types'
import { setupMockClient } from '../testing/index.js'

// P2-05 AC-4 (unit) and decision 5: <nymbal-sort-dropdown sort-keys='[…]' value> offers one option per key the store
// reports, in the report's order, labelled from PRODUCT_SORT_LABELS; a value the keys lack selects the default sort;
// choosing an option emits nymbal:sort:changed naming the key. Kills: a hard-coded option list that survives (an
// absent key offered, the report's order ignored), an unknown ?sort shown as selected, and a choice that never
// reaches the template's handler.

beforeEach(() => {
  setupMockClient()
})

function mount(keys: readonly string[], value: string): HTMLElement {
  const el = document.createElement('nymbal-sort-dropdown')
  el.setAttribute('sort-keys', JSON.stringify(keys))
  el.setAttribute('value', value)
  // The report's defaultSort, for an element that takes it from an attribute; the native default otherwise.
  el.setAttribute('default-sort', DEFAULT_PRODUCT_SORT)
  document.body.appendChild(el)
  return el
}

function selectOf(el: HTMLElement): HTMLSelectElement {
  const select = el.querySelector('select')
  if (select === null) throw new Error('nymbal-sort-dropdown rendered no <select>')
  return select
}

const arbKeys = fc.shuffledSubarray([...PRODUCT_SORT_KEYS], { minLength: 1 })

describe('nymbal-sort-dropdown', () => {
  it('AC-4: over generated subsets and orders of sortKeys, the options are exactly the keys in that order, labelled from PRODUCT_SORT_LABELS, with value selected', () => {
    fc.assert(
      fc.property(
        arbKeys.chain((keys) => fc.tuple(fc.constant(keys), fc.constantFrom(...keys))),
        ([keys, value]) => {
          const el = mount(keys, value)
          try {
            const options = [...selectOf(el).options]

            expect(options.map((o) => o.value)).toEqual(keys)
            expect(options.map((o) => o.textContent?.trim())).toEqual(
              keys.map((k) => PRODUCT_SORT_LABELS[k]),
            )
            expect(selectOf(el).value).toBe(value)
          } finally {
            el.remove()
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-4: over generated key sets holding the default and values outside them, the default sort is selected', () => {
    const arbWithDefault = fc
      .shuffledSubarray(
        PRODUCT_SORT_KEYS.filter((k) => k !== DEFAULT_PRODUCT_SORT),
        { minLength: 0 },
      )
      .chain((rest) =>
        fc
          .integer({ min: 0, max: rest.length })
          .map((at) => [...rest.slice(0, at), DEFAULT_PRODUCT_SORT, ...rest.slice(at)]),
      )
    fc.assert(
      fc.property(
        arbWithDefault,
        fc
          .string({ maxLength: 12 })
          .filter((v) => !(PRODUCT_SORT_KEYS as readonly string[]).includes(v)),
        (keys, unknown) => {
          const el = mount(keys, unknown)
          try {
            expect(selectOf(el).value).toBe(DEFAULT_PRODUCT_SORT)
            expect([...selectOf(el).options].map((o) => o.value)).toEqual(keys)
          } finally {
            el.remove()
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-4: a key outside the report is never offered, even as the value', () => {
    const keys: ProductSortKey[] = ['price-asc', 'newest']
    const el = mount(keys, 'name-desc')

    expect([...selectOf(el).options].map((o) => o.value)).toEqual(keys)
    expect(selectOf(el).value).toBe(DEFAULT_PRODUCT_SORT)
  })

  it('AC-4: choosing each offered option emits one bubbling nymbal:sort:changed naming that key', () => {
    const keys = [...PRODUCT_SORT_KEYS].reverse()
    const el = mount(keys, DEFAULT_PRODUCT_SORT)
    const seen: unknown[] = []
    document.body.addEventListener('nymbal:sort:changed', (e) => {
      seen.push((e as CustomEvent).detail)
    })
    const select = selectOf(el)

    for (const key of keys) {
      select.value = key
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }

    expect(seen).toHaveLength(keys.length)
    expect(
      seen.map((detail) =>
        keys.find((k) => Object.values((detail ?? {}) as Record<string, unknown>).includes(k)),
      ),
    ).toEqual(keys)
  })
})
